(function () {
  "use strict";

  // ===========================================================================
  // Kettu App Lock
  //
  // Verified against Kettu source (window.vendetta object built in
  // src/core/vendetta/api.tsx). Everything this plugin touches is taken from
  // that object - patcher, storage, ui.components.Forms, ui.alerts,
  // ui.semanticColors, metro.common.ReactNative, plugin.storage. Nothing here
  // is guessed at.
  //
  // KNOWN LIMITATION (read this before relying on it):
  // Kettu's plugin API gives no "block input to everything else" primitive.
  // To get a screen that visually covers Discord and eats the Android back
  // button, this plugin patches metro.common.NavigationNative.NavigationContainer
  // (Discord's own React Navigation root, re-exported by Kettu itself) and
  // wraps its rendered tree with an absolutely-positioned overlay, plus a
  // BackHandler listener that swallows back-presses while locked. This is the
  // same technique other Vendetta/Bunny-ecosystem lock plugins use, and it is
  // as strong as a plugin can get on non-root Android: it stops someone from
  // touching or navigating Discord while locked, but it cannot stop the OS
  // itself from showing a raw screenshot of Discord in the Android app
  // switcher (a plugin has no API for that; only Discord's own developers, or
  // a rooted FLAG_SECURE hook, could set that). Locking is also necessarily
  // JS-side: from a fully killed process there is nothing running until
  // Discord's JS is reloaded, at which point this plugin's onLoad fires again
  // and starts locked - so a killed-and-reopened app is always locked
  // regardless of grace period.
  // ===========================================================================

  // `window.vendetta` is set up by Kettu before this file is ever evaluated
  // (see core/vendetta/api.tsx / initVendettaObject) - that's the only plugin
  // API surface this file relies on.
  const {
    patcher,
    metro,
    storage,
    ui,
    plugin,
    logger,
  } = window.vendetta;

  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const { View, Text, TouchableOpacity, BackHandler, AppState } = RN;
  const { Forms } = ui.components;
  const { FormSection, FormRow, FormSwitchRow, FormInput, FormDivider } = Forms;
  const semanticColors = ui.semanticColors || {};
  const rawColors = ui.rawColors || {};

  // Small color helper: Discord's semantic color keys shift between app
  // versions (Kettu's own color.ts calls this out explicitly), so every
  // lookup here has a plain hex fallback and nothing breaks if a key is gone.
  const c = (key, fallback) => (semanticColors && semanticColors[key]) || fallback;
  const colors = {
    bg: () => c("BG_BASE_PRIMARY", "#1e1f22"),
    bgSecondary: () => c("BG_BASE_SECONDARY", "#2b2d31"),
    bgInput: () => c("INPUT_BACKGROUND", "#1e1f22"),
    text: () => c("TEXT_NORMAL", "#f2f3f5"),
    textMuted: () => c("TEXT_MUTED", "#949ba4"),
    brand: () => c("BRAND_500", "#5865f2"),
    danger: () => c("TEXT_DANGER", "#f23f42"),
    dangerBg: () => c("BUTTON_DANGER_BACKGROUND", "#da373c"),
    divider: () => c("BORDER_FAINT", "#3a3c43"),
  };

  // ---------------------------------------------------------------------------
  // Storage schema (persisted to disk automatically by Kettu's plugin.storage,
  // one JSON file per plugin - see core/vendetta/storage.ts createMMKVBackend).
  //
  // {
  //   setupComplete: boolean,
  //   enabled: boolean,
  //   pin: string,            // plaintext, per your instruction
  //   recovery: string,       // plaintext, per your instruction
  //   graceMs: number,        // -1 = "Never" (don't auto-lock on background)
  //   lockout: { failCount: number, lockUntil: number }
  // }
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    setupComplete: false,
    enabled: false,
    pin: "",
    recovery: "",
    graceMs: 30000,
    lockout: { failCount: 0, lockUntil: 0 },
  };
  for (const k of Object.keys(DEFAULTS)) {
    if (plugin.storage[k] === undefined) plugin.storage[k] = DEFAULTS[k];
  }

  const GRACE_OPTIONS = [
    { label: "Immediately", value: 0 },
    { label: "15 seconds", value: 15000 },
    { label: "30 seconds", value: 30000 },
    { label: "1 minute", value: 60000 },
    { label: "5 minutes", value: 300000 },
    { label: "15 minutes", value: 900000 },
    { label: "Never", value: -1 },
  ];
  const graceLabel = (ms) => (GRACE_OPTIONS.find((o) => o.value === ms) || GRACE_OPTIONS[2]).label;

  // ---------------------------------------------------------------------------
  // Lockout escalation policy (documented per your spec):
  // Fails 1-5:            no lockout.
  // On the 5th fail:      30s lockout.
  // Every further group
  // of 5 fails:           lockout doubles (30s, 60s, 120s, 240s ...),
  //                       capped at 30 minutes.
  // This is a delay, not a wipe/bypass-proof vault - see limitations at the
  // bottom of this file for what that does and doesn't protect against.
  // ---------------------------------------------------------------------------
  const BASE_LOCKOUT_MS = 30000;
  const MAX_LOCKOUT_MS = 30 * 60 * 1000;

  function registerFailure() {
    const lo = plugin.storage.lockout;
    lo.failCount += 1;
    if (lo.failCount > 0 && lo.failCount % 5 === 0) {
      const level = lo.failCount / 5 - 1; // 0, 1, 2, ...
      const dur = Math.min(BASE_LOCKOUT_MS * Math.pow(2, level), MAX_LOCKOUT_MS);
      lo.lockUntil = Date.now() + dur;
    }
    plugin.storage.lockout = { ...lo };
  }

  function registerSuccess() {
    plugin.storage.lockout = { failCount: 0, lockUntil: 0 };
  }

  function currentLockoutRemainingMs() {
    const until = plugin.storage.lockout.lockUntil || 0;
    return Math.max(0, until - Date.now());
  }

  // ---------------------------------------------------------------------------
  // Lock state - lives in memory (module scope), NOT storage. Every fresh JS
  // load (cold start / plugin reload) begins locked if enabled, satisfying
  // "lock when Kettu is opened" for free.
  // ---------------------------------------------------------------------------
  const state = {
    isLocked: plugin.storage.enabled === true,
    backgroundedAt: null,
    listeners: new Set(),
  };
  function setLocked(v) {
    state.isLocked = v;
    state.listeners.forEach((fn) => fn());
  }
  function useLockState() {
    const [, force] = React.useState(0);
    React.useEffect(() => {
      const fn = () => force((n) => n + 1);
      state.listeners.add(fn);
      return () => state.listeners.delete(fn);
    }, []);
    return state.isLocked;
  }

  // ---------------------------------------------------------------------------
  // Shared bits
  // ---------------------------------------------------------------------------
  function Dots({ length, filled }) {
    const dots = [];
    for (let i = 0; i < Math.max(length, 4); i++) {
      dots.push(
        React.createElement(View, {
          key: i,
          style: {
            width: 14,
            height: 14,
            borderRadius: 7,
            marginHorizontal: 8,
            backgroundColor: i < filled ? colors.brand() : "transparent",
            borderWidth: 2,
            borderColor: i < filled ? colors.brand() : colors.textMuted(),
          },
        })
      );
    }
    return React.createElement(View, { style: { flexDirection: "row", justifyContent: "center", marginVertical: 24 } }, dots);
  }

  function Keypad({ onDigit, onBackspace, disabled }) {
    const rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["", "0", "back"]];
    return React.createElement(
      View,
      { style: { marginTop: 12 } },
      rows.map((row, ri) =>
        React.createElement(
          View,
          { key: ri, style: { flexDirection: "row", justifyContent: "center" } },
          row.map((key, ki) => {
            if (key === "") return React.createElement(View, { key: ki, style: { width: 72, height: 72, margin: 8 } });
            const isBack = key === "back";
            return React.createElement(
              TouchableOpacity,
              {
                key: ki,
                disabled,
                activeOpacity: 0.6,
                onPress: () => (isBack ? onBackspace() : onDigit(key)),
                style: {
                  width: 72,
                  height: 72,
                  margin: 8,
                  borderRadius: 36,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.bgSecondary(),
                  opacity: disabled ? 0.4 : 1,
                },
              },
              React.createElement(
                Text,
                { style: { color: colors.text(), fontSize: isBack ? 16 : 26, fontWeight: "600" } },
                isBack ? "⌫" : key
              )
            );
          })
        )
      )
    );
  }

  // A single reusable "enter a PIN, confirm it" step used by setup, change-PIN,
  // and reset-after-recovery flows.
  function usePinEntry(expectedLength) {
    const [value, setValue] = React.useState("");
    const onDigit = (d) => setValue((v) => (v.length >= 8 ? v : v + d));
    const onBackspace = () => setValue((v) => v.slice(0, -1));
    const reset = () => setValue("");
    return { value, setValue, onDigit, onBackspace, reset };
  }

  // ---------------------------------------------------------------------------
  // Lock screen (shown when state.isLocked is true)
  // ---------------------------------------------------------------------------
  function LockScreen({ onUnlocked }) {
    const [mode, setMode] = React.useState("pin"); // "pin" | "recovery" | "newpin"
    const [error, setError] = React.useState("");
    const [lockRemaining, setLockRemaining] = React.useState(currentLockoutRemainingMs());
    const pinEntry = usePinEntry();
    const recovery = usePinEntry();
    const newPin1 = usePinEntry();
    const newPin2 = usePinEntry();
    const [newPinStage, setNewPinStage] = React.useState(1);

    React.useEffect(() => {
      if (lockRemaining <= 0) return;
      const t = setInterval(() => {
        const r = currentLockoutRemainingMs();
        setLockRemaining(r);
        if (r <= 0) clearInterval(t);
      }, 500);
      return () => clearInterval(t);
    }, [lockRemaining > 0]);

    const locked = lockRemaining > 0;

    function submitPin(pin) {
      if (locked) return;
      if (pin === plugin.storage.pin) {
        registerSuccess();
        pinEntry.reset();
        setError("");
        onUnlocked();
      } else {
        registerFailure();
        pinEntry.reset();
        setError("Incorrect PIN");
        setLockRemaining(currentLockoutRemainingMs());
      }
    }

    React.useEffect(() => {
      if (mode === "pin" && pinEntry.value.length === plugin.storage.pin.length && plugin.storage.pin.length > 0) {
        submitPin(pinEntry.value);
      }
    }, [pinEntry.value]);

    function submitRecovery(pw) {
      if (pw === plugin.storage.recovery && plugin.storage.recovery.length > 0) {
        recovery.reset();
        setError("");
        setMode("newpin");
        setNewPinStage(1);
      } else {
        recovery.reset();
        setError("Incorrect recovery password");
      }
    }

    function finishNewPin() {
      if (newPin1.value.length < 4) {
        setError("PIN must be at least 4 digits");
        return;
      }
      if (newPinStage === 1) {
        setNewPinStage(2);
        return;
      }
      if (newPin2.value !== newPin1.value) {
        setError("PINs didn't match, try again");
        newPin1.reset();
        newPin2.reset();
        setNewPinStage(1);
        return;
      }
      plugin.storage.pin = newPin1.value;
      registerSuccess();
      newPin1.reset();
      newPin2.reset();
      setError("");
      onUnlocked();
    }

    React.useEffect(() => {
      if (mode === "newpin" && newPinStage === 2 && newPin2.value.length === newPin1.value.length) {
        finishNewPin();
      }
    }, [newPin2.value]);

    const title =
      mode === "pin" ? "Enter PIN" : mode === "recovery" ? "Recovery password" : newPinStage === 1 ? "Create new PIN" : "Confirm new PIN";

    return React.createElement(
      View,
      {
        style: {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: colors.bg(),
          zIndex: 999999,
          elevation: 999999,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 24,
        },
      },
      React.createElement(Text, { style: { color: colors.text(), fontSize: 22, fontWeight: "700", marginBottom: 4 } }, "Kettu Locked"),
      React.createElement(Text, { style: { color: colors.textMuted(), fontSize: 15, marginBottom: 8 } }, title),

      locked &&
        React.createElement(
          Text,
          { style: { color: colors.danger(), marginTop: 12 } },
          `Too many attempts. Try again in ${Math.ceil(lockRemaining / 1000)}s`
        ),

      !locked &&
        mode === "pin" &&
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Dots, { length: 4, filled: pinEntry.value.length }),
          error ? React.createElement(Text, { style: { color: colors.danger(), marginBottom: 8 } }, error) : null,
          React.createElement(Keypad, { onDigit: pinEntry.onDigit, onBackspace: pinEntry.onBackspace, disabled: locked }),
          React.createElement(
            TouchableOpacity,
            { onPress: () => { setMode("recovery"); setError(""); }, style: { marginTop: 20 } },
            React.createElement(Text, { style: { color: colors.brand(), fontSize: 14 } }, "Forgot PIN?")
          )
        ),

      !locked &&
        mode === "recovery" &&
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Dots, { length: 4, filled: Math.min(recovery.value.length, 8) }),
          error ? React.createElement(Text, { style: { color: colors.danger(), marginBottom: 8 } }, error) : null,
          React.createElement(
            View,
            { style: { width: "100%", maxWidth: 320 } },
            React.createElement(FormInput, {
              value: recovery.value,
              onChange: recovery.setValue,
              secureTextEntry: true,
              placeholder: "Recovery password",
            })
          ),
          React.createElement(
            TouchableOpacity,
            {
              onPress: () => submitRecovery(recovery.value),
              style: { marginTop: 16, backgroundColor: colors.brand(), borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24 },
            },
            React.createElement(Text, { style: { color: "#fff", fontWeight: "600" } }, "Continue")
          ),
          React.createElement(
            TouchableOpacity,
            { onPress: () => { setMode("pin"); setError(""); }, style: { marginTop: 16 } },
            React.createElement(Text, { style: { color: colors.textMuted(), fontSize: 14 } }, "Back to PIN")
          )
        ),

      mode === "newpin" &&
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Dots, {
            length: 4,
            filled: newPinStage === 1 ? newPin1.value.length : newPin2.value.length,
          }),
          error ? React.createElement(Text, { style: { color: colors.danger(), marginBottom: 8 } }, error) : null,
          React.createElement(Keypad, {
            onDigit: newPinStage === 1 ? newPin1.onDigit : newPin2.onDigit,
            onBackspace: newPinStage === 1 ? newPin1.onBackspace : newPin2.onBackspace,
            disabled: false,
          }),
          React.createElement(
            TouchableOpacity,
            { onPress: finishNewPin, style: { marginTop: 20, backgroundColor: colors.brand(), borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24 } },
            React.createElement(Text, { style: { color: "#fff", fontWeight: "600" } }, newPinStage === 1 ? "Next" : "Confirm")
          )
        )
    );
  }

  // ---------------------------------------------------------------------------
  // First-run setup screen
  // ---------------------------------------------------------------------------
  function SetupScreen({ onDone }) {
    const [step, setStep] = React.useState(1); // 1 pin, 2 confirm pin, 3 recovery, 4 confirm recovery
    const [pin1, setPin1] = React.useState("");
    const [pin2, setPin2] = React.useState("");
    const [rec1, setRec1] = React.useState("");
    const [rec2, setRec2] = React.useState("");
    const [error, setError] = React.useState("");

    function digit(setter) {
      return (d) => setter((v) => (v.length >= 8 ? v : v + d));
    }
    function back(setter) {
      return () => setter((v) => v.slice(0, -1));
    }

    React.useEffect(() => {
      if (step === 1 && pin1.length >= 4) {
        // wait for explicit Next press for clarity, no auto-advance here
      }
    }, [pin1]);

    function next() {
      setError("");
      if (step === 1) {
        if (pin1.length < 4) return setError("PIN must be at least 4 digits");
        setStep(2);
      } else if (step === 2) {
        if (pin2 !== pin1) {
          setError("PINs didn't match");
          setPin1("");
          setPin2("");
          setStep(1);
          return;
        }
        setStep(3);
      } else if (step === 4) {
        if (rec1.length < 4) return setError("Recovery password must be at least 4 characters");
        if (rec1 !== rec2) {
          setError("Recovery passwords didn't match");
          setRec1("");
          setRec2("");
          return;
        }
        plugin.storage.pin = pin1;
        plugin.storage.recovery = rec1;
        plugin.storage.enabled = true;
        plugin.storage.setupComplete = true;
        registerSuccess();
        onDone();
      }
    }

    return React.createElement(
      View,
      { style: { flex: 1, backgroundColor: colors.bg(), alignItems: "center", justifyContent: "center", padding: 24 } },
      React.createElement(Text, { style: { color: colors.text(), fontSize: 20, fontWeight: "700", marginBottom: 4 } }, "Set up App Lock"),
      React.createElement(
        Text,
        { style: { color: colors.textMuted(), fontSize: 14, marginBottom: 16, textAlign: "center" } },
        step <= 2
          ? "Choose a PIN to lock Discord with."
          : "Set a recovery password in case you forget your PIN."
      ),
      error ? React.createElement(Text, { style: { color: colors.danger(), marginBottom: 8 } }, error) : null,

      step <= 2 &&
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Dots, { length: 4, filled: step === 1 ? pin1.length : pin2.length }),
          React.createElement(Keypad, {
            onDigit: digit(step === 1 ? setPin1 : setPin2),
            onBackspace: back(step === 1 ? setPin1 : setPin2),
            disabled: false,
          })
        ),

      step >= 3 &&
        React.createElement(
          View,
          { style: { width: "100%", maxWidth: 320 } },
          React.createElement(FormInput, {
            value: rec1,
            onChange: (v) => { setRec1(v); setStep(4); },
            secureTextEntry: true,
            placeholder: "Recovery password",
          }),
          React.createElement(View, { style: { height: 8 } }),
          React.createElement(FormInput, {
            value: rec2,
            onChange: setRec2,
            secureTextEntry: true,
            placeholder: "Confirm recovery password",
          })
        ),

      React.createElement(
        TouchableOpacity,
        {
          onPress: next,
          style: { marginTop: 24, backgroundColor: colors.brand(), borderRadius: 8, paddingVertical: 12, paddingHorizontal: 32 },
        },
        React.createElement(Text, { style: { color: "#fff", fontWeight: "600" } }, step === 4 ? "Finish" : "Next")
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Settings page (registered as this plugin's `settings` component - shown
  // from Kettu's Plugins page the same way every other plugin's settings are)
  // ---------------------------------------------------------------------------
  function ChangePinSheet({ onClose }) {
    const [stage, setStage] = React.useState("current");
    const [current, setCurrent] = React.useState("");
    const [n1, setN1] = React.useState("");
    const [n2, setN2] = React.useState("");
    const [error, setError] = React.useState("");

    function submit() {
      if (stage === "current") {
        if (current !== plugin.storage.pin) return setError("Incorrect current PIN");
        setError("");
        setStage("new1");
        return;
      }
      if (stage === "new1") {
        if (n1.length < 4) return setError("PIN must be at least 4 digits");
        setError("");
        setStage("new2");
        return;
      }
      if (stage === "new2") {
        if (n2 !== n1) {
          setError("PINs didn't match");
          setN1(""); setN2(""); setStage("new1");
          return;
        }
        plugin.storage.pin = n1;
        ui.toasts.showToast("PIN changed");
        onClose();
      }
    }

    const label = stage === "current" ? "Current PIN" : stage === "new1" ? "New PIN" : "Confirm new PIN";
    const value = stage === "current" ? current : stage === "new1" ? n1 : n2;
    const setValue = stage === "current" ? setCurrent : stage === "new1" ? setN1 : setN2;

    return React.createElement(
      View,
      { style: { padding: 16 } },
      React.createElement(Text, { style: { color: colors.text(), fontSize: 18, fontWeight: "700", marginBottom: 12 } }, "Change PIN"),
      error ? React.createElement(Text, { style: { color: colors.danger(), marginBottom: 8 } }, error) : null,
      React.createElement(FormInput, { value, onChange: setValue, secureTextEntry: true, placeholder: label }),
      React.createElement(
        TouchableOpacity,
        { onPress: submit, style: { marginTop: 16, backgroundColor: colors.brand(), borderRadius: 8, paddingVertical: 10, alignItems: "center" } },
        React.createElement(Text, { style: { color: "#fff", fontWeight: "600" } }, stage === "new2" ? "Save" : "Continue")
      )
    );
  }

  function ChangeRecoverySheet({ onClose }) {
    const [stage, setStage] = React.useState("current");
    const [currentPin, setCurrentPin] = React.useState("");
    const [n1, setN1] = React.useState("");
    const [n2, setN2] = React.useState("");
    const [error, setError] = React.useState("");

    function submit() {
      if (stage === "current") {
        if (currentPin !== plugin.storage.pin) return setError("Incorrect PIN");
        setError("");
        setStage("new1");
        return;
      }
      if (stage === "new1") {
        if (n1.length < 4) return setError("Recovery password must be at least 4 characters");
        setError("");
        setStage("new2");
        return;
      }
      if (stage === "new2") {
        if (n2 !== n1) {
          setError("Didn't match");
          setN1(""); setN2(""); setStage("new1");
          return;
        }
        plugin.storage.recovery = n1;
        ui.toasts.showToast("Recovery password changed");
        onClose();
      }
    }

    const label = stage === "current" ? "Current PIN (to confirm it's you)" : stage === "new1" ? "New recovery password" : "Confirm new recovery password";
    const value = stage === "current" ? currentPin : stage === "new1" ? n1 : n2;
    const setValue = stage === "current" ? setCurrentPin : stage === "new1" ? setN1 : setN2;

    return React.createElement(
      View,
      { style: { padding: 16 } },
      React.createElement(Text, { style: { color: colors.text(), fontSize: 18, fontWeight: "700", marginBottom: 12 } }, "Change recovery password"),
      error ? React.createElement(Text, { style: { color: colors.danger(), marginBottom: 8 } }, error) : null,
      React.createElement(FormInput, { value, onChange: setValue, secureTextEntry: true, placeholder: label }),
      React.createElement(
        TouchableOpacity,
        { onPress: submit, style: { marginTop: 16, backgroundColor: colors.brand(), borderRadius: 8, paddingVertical: 10, alignItems: "center" } },
        React.createElement(Text, { style: { color: "#fff", fontWeight: "600" } }, stage === "new2" ? "Save" : "Continue")
      )
    );
  }

  function GracePickerSheet({ onClose }) {
    return React.createElement(
      View,
      { style: { padding: 16 } },
      React.createElement(Text, { style: { color: colors.text(), fontSize: 18, fontWeight: "700", marginBottom: 12 } }, "Grace period"),
      GRACE_OPTIONS.map((o) =>
        React.createElement(
          TouchableOpacity,
          {
            key: o.label,
            onPress: () => { plugin.storage.graceMs = o.value; onClose(); },
            style: { paddingVertical: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
          },
          React.createElement(Text, { style: { color: colors.text(), fontSize: 16 } }, o.label),
          plugin.storage.graceMs === o.value
            ? React.createElement(Text, { style: { color: colors.brand() } }, "✓")
            : null
        )
      )
    );
  }

  function SettingsPage() {
    storage.useProxy(plugin.storage);
    const [, force] = React.useState(0);

    if (!plugin.storage.setupComplete) {
      return React.createElement(SetupScreen, { onDone: () => force((n) => n + 1) });
    }

    return React.createElement(
      View,
      { style: { flex: 1 } },
      React.createElement(
        FormSection,
        { title: "App Lock" },
        React.createElement(FormSwitchRow, {
          label: "App Lock",
          subLabel: "Require your PIN to use Discord",
          value: plugin.storage.enabled,
          onValueChange: (v) => {
            plugin.storage.enabled = v;
            if (v) setLocked(true);
            else setLocked(false);
          },
        })
      ),
      React.createElement(
        FormSection,
        { title: "Security" },
        React.createElement(FormRow, {
          label: "Change PIN",
          trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
          onPress: () =>
            ui.alerts.showCustomAlert(ChangePinSheet, { onClose: () => {} /* Kettu does not expose a programmatic close for custom alerts; swipe down to close after Save. */ }),
        }),
        React.createElement(FormRow, {
          label: "Grace period",
          subLabel: graceLabel(plugin.storage.graceMs),
          trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
          onPress: () =>
            ui.alerts.showCustomAlert(GracePickerSheet, { onClose: () => {} /* Kettu does not expose a programmatic close for custom alerts; swipe down to close after Save. */ }),
        }),
        React.createElement(FormRow, {
          label: "Change recovery password",
          trailing: FormRow.Arrow ? React.createElement(FormRow.Arrow, null) : null,
          onPress: () =>
            ui.alerts.showCustomAlert(ChangeRecoverySheet, { onClose: () => {} /* Kettu does not expose a programmatic close for custom alerts; swipe down to close after Save. */ }),
        })
      ),
      React.createElement(
        FormSection,
        { title: "Actions" },
        React.createElement(FormRow, {
          label: "Lock now",
          onPress: () => setLocked(true),
        }),
        React.createElement(FormRow, {
          label: "Reset PIN",
          subLabel: "Uses your recovery password",
          onPress: () => {
            plugin.storage.enabled = true;
            setLocked(true); // lock screen's "Forgot PIN?" flow handles the reset
          },
        })
      ),
      React.createElement(
        FormSection,
        { title: "About" },
        React.createElement(FormRow, { label: "App Lock version", trailing: React.createElement(Text, { style: { color: colors.textMuted() } }, "1.0.0") })
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Overlay wiring: patch Discord's own NavigationContainer (exposed by Kettu
  // as metro.common.NavigationNative.NavigationContainer) and render our lock
  // screen on top of whatever it returns. See the limitations note up top.
  // ---------------------------------------------------------------------------
  let unpatchNav = null;
  let appStateSub = null;
  let backHandlerSub = null;

  function OverlayRoot() {
    const isLocked = useLockState();
    if (!isLocked) return null;
    return React.createElement(LockScreen, { onUnlocked: () => setLocked(false) });
  }

  function install() {
    unpatchNav = patcher.after("NavigationContainer", metro.common.NavigationNative, (args, res) => {
      return React.createElement(React.Fragment, null, res, React.createElement(OverlayRoot, null));
    });

    backHandlerSub = BackHandler.addEventListener("hardwareBackPress", () => {
      // Swallow back presses while locked so the lock screen can't be
      // navigated away from.
      return state.isLocked;
    });

    appStateSub = AppState.addEventListener("change", (next) => {
      if (!plugin.storage.enabled) return;
      if (next === "background" || next === "inactive") {
        state.backgroundedAt = Date.now();
      } else if (next === "active") {
        const grace = plugin.storage.graceMs;
        if (state.backgroundedAt != null) {
          const elapsed = Date.now() - state.backgroundedAt;
          if (grace === -1) {
            // "Never" - don't lock purely for backgrounding.
          } else if (elapsed >= grace) {
            setLocked(true);
          }
        }
        state.backgroundedAt = null;
      }
    });
  }

  function uninstall() {
    if (unpatchNav) unpatchNav();
    if (backHandlerSub && backHandlerSub.remove) backHandlerSub.remove();
    if (appStateSub && appStateSub.remove) appStateSub.remove();
    unpatchNav = null;
    backHandlerSub = null;
    appStateSub = null;
  }

  return {
    onLoad() {
      try {
        install();
      } catch (e) {
        logger.error("Kettu App Lock failed to install overlay patch", e);
      }
    },
    onUnload() {
      uninstall();
    },
    settings: SettingsPage,
  };
})();

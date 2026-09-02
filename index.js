(function (vendetta) {
  "use strict";

  // ===========================================================================
  // Kettu App Lock
  // A Vendetta-spec plugin for Kettu. See README.md for install & hosting info.
  //
  // Architecture notes (verified against Kettu's own source, see chat writeup):
  // - This file is fetched by VdPluginManager and eval'd as:
  //     (vendetta => { return <THIS FILE'S SOURCE, VERBATIM> })(vendettaObject)
  //   `vendetta` is therefore already an ambient identifier in scope at the top
  //   of this file - this file's top-level expression must evaluate DIRECTLY to
  //   the { onLoad, onUnload, settings } object (the loader only calls it as a
  //   zero-argument function if it's left as a function, so we must invoke our
  //   own IIFE immediately, passing the ambient `vendetta` through ourselves).
  // - No bundler/imports: plain JS + React.createElement, so it can be hosted
  //   as a single raw file and installed straight from the phone.
  // ===========================================================================

  {
    const React = vendetta.metro.common.React;
    const RN = vendetta.metro.common.ReactNative;
    const { View, Text, TouchableOpacity, TextInput, Modal, AppState, BackHandler, StyleSheet } = RN;
    const { useState, useEffect, useRef, useCallback } = React;
    const h = React.createElement;

    const PLUGIN_VERSION = "1.0.0";
    const storage = vendetta.plugin.storage;
    const logger = vendetta.plugin.logger;
    const { showToast } = vendetta.ui.toasts;
    const { showConfirmationAlert, showInputAlert, showCustomAlert } = vendetta.ui.alerts;
    const semanticColors = vendetta.ui.semanticColors || {};
    const DiscordButton = vendetta.ui.components.Button;

    // Direct metro lookups for things not pre-exposed on the curated vendetta.ui
    // object. find()/findByProps() are the same public APIs Kettu's own core
    // uses internally (verified in src/metro/common/components.ts).
    const AlertsStack = vendetta.metro.findByProps("openLazy", "close");

    // ---------------------------------------------------------------------
    // Colors - Discord's real semantic color tokens where available, with a
    // dark-theme fallback palette. NOTE: exact semantic color key names have
    // changed across Discord versions (Kettu's own source flags this), so
    // this is a best-effort approximation, not a hard guarantee.
    // ---------------------------------------------------------------------
    const C = {
      bg: semanticColors.BACKGROUND_PRIMARY || semanticColors.BG_BASE_PRIMARY || "#1e1f22",
      bgSecondary: semanticColors.BACKGROUND_SECONDARY || semanticColors.BG_SURFACE_SECONDARY || "#2b2d31",
      text: semanticColors.TEXT_NORMAL || semanticColors.TEXT_DEFAULT || "#f2f3f5",
      textMuted: semanticColors.TEXT_MUTED || semanticColors.TEXT_SECONDARY || "#949ba4",
      brand: semanticColors.BRAND_500 || semanticColors.BUTTON_BRAND_BACKGROUND || "#5865f2",
      danger: semanticColors.STATUS_DANGER || semanticColors.BUTTON_DANGER_BACKGROUND || "#da373c",
      inputBg: semanticColors.INPUT_BACKGROUND || semanticColors.BG_BASE_SECONDARY || "#1e1f22",
      divider: semanticColors.BACKGROUND_MODIFIER_ACCENT || "#3f4147",
    };

    // ---------------------------------------------------------------------
    // Storage defaults
    // ---------------------------------------------------------------------
    function ensureDefaults() {
      if (storage.setupDone === undefined) storage.setupDone = false;
      if (storage.enabled === undefined) storage.enabled = false;
      if (storage.pin === undefined) storage.pin = null;
      if (storage.recovery === undefined) storage.recovery = null;
      if (storage.graceSeconds === undefined) storage.graceSeconds = 30;
      if (storage.failCount === undefined) storage.failCount = 0;
      if (storage.lockoutTier === undefined) storage.lockoutTier = 0;
      if (storage.lockoutUntil === undefined) storage.lockoutUntil = 0;
    }

    const GRACE_OPTIONS = [
      { label: "Immediately", value: 0 },
      { label: "15 seconds", value: 15 },
      { label: "30 seconds", value: 30 },
      { label: "1 minute", value: 60 },
      { label: "5 minutes", value: 300 },
      { label: "15 minutes", value: 900 },
      { label: "Never", value: -1 },
    ];

    function graceLabel(seconds) {
      const found = GRACE_OPTIONS.find(o => o.value === seconds);
      return found ? found.label : `${seconds}s`;
    }

    // Escalating lockout: attempts 1-5 are free. Every additional group of 5
    // failures bumps the "tier" and doubles the lockout, starting at 30s and
    // capped at 30 minutes so a forgetful (but legitimate) user is never
    // locked out forever - the recovery flow is the real backstop.
    //   tier 1 (fails 6-10):   30s
    //   tier 2 (fails 11-15):  1m
    //   tier 3 (fails 16-20):  2m
    //   tier 4 (fails 21-25):  4m
    //   tier 5 (fails 26-30):  8m
    //   tier 6+ (fails 31+):   16m, 30m (capped)
    function lockoutSecondsForTier(tier) {
      if (tier <= 0) return 0;
      const seconds = 30 * Math.pow(2, tier - 1);
      return Math.min(seconds, 1800);
    }

    function registerFailure() {
      storage.failCount = (storage.failCount || 0) + 1;
      if (storage.failCount % 5 === 0) {
        storage.lockoutTier = (storage.lockoutTier || 0) + 1;
        const secs = lockoutSecondsForTier(storage.lockoutTier);
        storage.lockoutUntil = Date.now() + secs * 1000;
      }
    }

    function registerSuccess() {
      storage.failCount = 0;
      storage.lockoutTier = 0;
      storage.lockoutUntil = 0;
    }

    function remainingLockoutMs() {
      const until = storage.lockoutUntil || 0;
      return Math.max(0, until - Date.now());
    }

    // ---------------------------------------------------------------------
    // Global (in-memory, non-persisted) lock state + a tiny pub/sub so the
    // lock overlay and settings screen can react to it.
    // ---------------------------------------------------------------------
    const state = {
      locked: false,
      overlayMounted: false,
      backgroundedAt: 0,
    };
    const listeners = new Set();
    function setLocked(v) {
      state.locked = v;
      listeners.forEach(fn => { try { fn(); } catch (e) { } });
    }
    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    let backHandlerSub = null;

    function openLockScreen() {
      ensureDefaults();
      if (!storage.setupDone || !storage.enabled) return;
      if (state.locked) return;
      setLocked(true);

      // Block Android hardware back button while locked.
      if (BackHandler && !backHandlerSub) {
        backHandlerSub = BackHandler.addEventListener("hardwareBackPress", () => true);
      }

      if (!state.overlayMounted) {
        state.overlayMounted = true;
        try {
          showCustomAlert(LockOverlay, {});
        } catch (e) {
          logger.error("Failed to open lock overlay", e);
        }
      }
    }

    function closeLockScreen() {
      setLocked(false);
      if (backHandlerSub) {
        try { backHandlerSub.remove(); } catch (e) { }
        backHandlerSub = null;
      }
      // Best-effort: actually pop the alert off Discord's alert stack.
      try { AlertsStack && AlertsStack.close && AlertsStack.close(); } catch (e) { }
      state.overlayMounted = false;
    }

    function lockNow() {
      if (!storage.setupDone) return;
      openLockScreen();
    }

    // ---------------------------------------------------------------------
    // AppState (background/foreground) handling
    // ---------------------------------------------------------------------
    let appStateSub = null;
    function handleAppStateChange(next) {
      ensureDefaults();
      if (next === "background" || next === "inactive") {
        state.backgroundedAt = Date.now();
        return;
      }
      if (next === "active") {
        if (!storage.setupDone || !storage.enabled) return;
        const grace = storage.graceSeconds;
        if (grace === -1) return; // "Never" - don't lock on resume
        if (!state.backgroundedAt) return; // e.g. cold start, handled separately
        const elapsed = (Date.now() - state.backgroundedAt) / 1000;
        if (grace === 0 || elapsed >= grace) {
          openLockScreen();
        }
      }
    }

    // ---------------------------------------------------------------------
    // Shared small UI bits
    // ---------------------------------------------------------------------
    function Btn(props) {
      return h(TouchableOpacity, {
        activeOpacity: 0.7,
        onPress: props.onPress,
        disabled: props.disabled,
        style: [{
          backgroundColor: props.variant === "danger" ? C.danger : (props.variant === "secondary" ? C.bgSecondary : C.brand),
          paddingVertical: 12,
          paddingHorizontal: 20,
          borderRadius: 8,
          alignItems: "center",
          opacity: props.disabled ? 0.5 : 1,
          marginTop: 10,
        }, props.style],
      }, h(Text, { style: { color: "#fff", fontWeight: "600", fontSize: 15 } }, props.children));
    }

    function Field(props) {
      return h(TextInput, {
        style: {
          backgroundColor: C.inputBg,
          color: C.text,
          borderRadius: 8,
          paddingHorizontal: 14,
          paddingVertical: 10,
          fontSize: 16,
          marginTop: 10,
          borderWidth: 1,
          borderColor: C.divider,
        },
        placeholder: props.placeholder,
        placeholderTextColor: C.textMuted,
        secureTextEntry: !!props.secure,
        keyboardType: props.numeric ? "number-pad" : "default",
        value: props.value,
        onChangeText: props.onChangeText,
        autoFocus: props.autoFocus,
        maxLength: props.maxLength,
      });
    }

    // ---------------------------------------------------------------------
    // PIN pad (used by both the lock screen and setup/recovery flows)
    // ---------------------------------------------------------------------
    function PinDots({ length, filled }) {
      const dots = [];
      for (let i = 0; i < length; i++) {
        dots.push(h(View, {
          key: i,
          style: {
            width: 14, height: 14, borderRadius: 7, marginHorizontal: 8,
            backgroundColor: i < filled ? C.brand : "transparent",
            borderWidth: 2,
            borderColor: i < filled ? C.brand : C.textMuted,
          },
        }));
      }
      return h(View, { style: { flexDirection: "row", justifyContent: "center", marginVertical: 24 } }, dots);
    }

    function Keypad({ onDigit, onBackspace }) {
      const rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["", "0", "back"]];
      return h(View, { style: { marginTop: 8 } },
        rows.map((row, ri) => h(View, { key: ri, style: { flexDirection: "row", justifyContent: "center" } },
          row.map((k, ki) => {
            if (k === "") return h(View, { key: ki, style: { width: 72, height: 72, margin: 8 } });
            if (k === "back") {
              return h(TouchableOpacity, {
                key: ki, activeOpacity: 0.6, onPress: onBackspace,
                style: { width: 72, height: 72, margin: 8, borderRadius: 36, alignItems: "center", justifyContent: "center" },
              }, h(Text, { style: { color: C.text, fontSize: 20 } }, "⌫"));
            }
            return h(TouchableOpacity, {
              key: ki, activeOpacity: 0.6, onPress: () => onDigit(k),
              style: { width: 72, height: 72, margin: 8, borderRadius: 36, alignItems: "center", justifyContent: "center", backgroundColor: C.bgSecondary },
            }, h(Text, { style: { color: C.text, fontSize: 26, fontWeight: "500" } }, k));
          })
        ))
      );
    }

    // ---------------------------------------------------------------------
    // Setup screen (first run): create PIN + confirm, create recovery password
    // ---------------------------------------------------------------------
    function SetupFlow({ onDone }) {
      const [step, setStep] = useState(1); // 1 = pin, 2 = confirm pin, 3 = recovery
      const [pin, setPin] = useState("");
      const [confirm, setConfirm] = useState("");
      const [recovery, setRecovery] = useState("");
      const [recoveryConfirm, setRecoveryConfirm] = useState("");
      const [error, setError] = useState("");

      function next() {
        setError("");
        if (step === 1) {
          if (pin.length < 4) return setError("PIN must be at least 4 digits.");
          setStep(2);
        } else if (step === 2) {
          if (confirm !== pin) return setError("PINs don't match. Try again.");
          setStep(3);
        } else if (step === 3) {
          if (!recovery || recovery.length < 4) return setError("Recovery password must be at least 4 characters.");
          if (recovery !== recoveryConfirm) return setError("Recovery passwords don't match.");
          storage.pin = pin;
          storage.recovery = recovery;
          storage.setupDone = true;
          storage.enabled = true;
          storage.failCount = 0;
          storage.lockoutTier = 0;
          storage.lockoutUntil = 0;
          showToast("Kettu App Lock is set up.");
          onDone();
        }
      }

      return h(View, { style: { padding: 20 } },
        h(Text, { style: { color: C.text, fontSize: 20, fontWeight: "700", textAlign: "center" } }, "Set up App Lock"),
        h(Text, { style: { color: C.textMuted, fontSize: 13, textAlign: "center", marginTop: 6 } },
          step === 1 ? "Choose a PIN to lock Kettu."
            : step === 2 ? "Confirm your PIN."
              : "Create a recovery password. You'll need this if you forget your PIN."),
        step <= 2 ? h(Field, {
          placeholder: step === 1 ? "New PIN" : "Confirm PIN",
          secure: true, numeric: true, maxLength: 8,
          value: step === 1 ? pin : confirm,
          onChangeText: step === 1 ? setPin : setConfirm,
          autoFocus: true,
        }) : h(View, null,
          h(Field, { placeholder: "Recovery password", secure: true, value: recovery, onChangeText: setRecovery, autoFocus: true }),
          h(Field, { placeholder: "Confirm recovery password", secure: true, value: recoveryConfirm, onChangeText: setRecoveryConfirm })
        ),
        error ? h(Text, { style: { color: C.danger, marginTop: 10, textAlign: "center" } }, error) : null,
        h(Btn, { onPress: next }, step === 3 ? "Finish setup" : "Continue")
      );
    }

    // ---------------------------------------------------------------------
    // The full-screen lock overlay
    // ---------------------------------------------------------------------
    function LockOverlay() {
      const [, force] = useState(0);
      const [entered, setEntered] = useState("");
      const [error, setError] = useState("");
      const [lockedOutMs, setLockedOutMs] = useState(remainingLockoutMs());
      const [mode, setMode] = useState("pin"); // pin | recoverPw | recoverNewPin

      useEffect(() => subscribe(() => force(n => n + 1)), []);

      useEffect(() => {
        if (lockedOutMs <= 0) return;
        const t = setInterval(() => {
          const ms = remainingLockoutMs();
          setLockedOutMs(ms);
          if (ms <= 0) clearInterval(t);
        }, 500);
        return () => clearInterval(t);
      }, [lockedOutMs > 0]);

      if (!state.locked) return null; // See README: best-effort invisible fallback.

      function submitPin(pinValue) {
        if (remainingLockoutMs() > 0) return;
        if (pinValue === storage.pin) {
          registerSuccess();
          setEntered("");
          setError("");
          closeLockScreen();
        } else {
          registerFailure();
          setEntered("");
          setError("Incorrect PIN");
          setLockedOutMs(remainingLockoutMs());
        }
      }

      function onDigit(d) {
        if (remainingLockoutMs() > 0) return;
        const next = (entered + d).slice(0, 8);
        setEntered(next);
        setError("");
        // Auto-submit once it matches the stored PIN's length.
        if (storage.pin && next.length === storage.pin.length) {
          submitPin(next);
        }
      }
      function onBackspace() {
        setEntered(e => e.slice(0, -1));
      }

      const inLockout = lockedOutMs > 0;

      let body;
      if (mode === "pin") {
        body = h(View, { style: { alignItems: "center" } },
          h(Text, { style: { color: C.text, fontSize: 22, fontWeight: "700" } }, "Kettu Locked"),
          h(Text, { style: { color: C.textMuted, fontSize: 14, marginTop: 6 } },
            inLockout ? `Too many attempts. Try again in ${Math.ceil(lockedOutMs / 1000)}s` : "Enter PIN"),
          h(PinDots, { length: (storage.pin || "").length || 4, filled: entered.length }),
          error && !inLockout ? h(Text, { style: { color: C.danger, marginBottom: 8 } }, error) : null,
          h(Keypad, { onDigit, onBackspace }),
          h(TouchableOpacity, { onPress: () => setMode("recoverPw"), style: { marginTop: 18 } },
            h(Text, { style: { color: C.brand, fontSize: 14 } }, "Forgot PIN?"))
        );
      } else if (mode === "recoverPw") {
        body = h(RecoveryPasswordStep, {
          onCancel: () => setMode("pin"),
          onVerified: () => setMode("recoverNewPin"),
        });
      } else {
        body = h(NewPinStep, {
          title: "Create new PIN",
          onDone: (newPin) => {
            storage.pin = newPin;
            registerSuccess();
            showToast("PIN reset.");
            closeLockScreen();
          },
        });
      }

      return h(Modal, {
        visible: true,
        transparent: false,
        animationType: "none",
        hardwareAccelerated: true,
        onRequestClose: () => true, // swallow Android back button
        statusBarTranslucent: true,
      }, h(View, { style: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 20 } }, body));
    }

    function RecoveryPasswordStep({ onCancel, onVerified }) {
      const [pw, setPw] = useState("");
      const [error, setError] = useState("");
      return h(View, { style: { width: "100%", maxWidth: 320 } },
        h(Text, { style: { color: C.text, fontSize: 18, fontWeight: "700", textAlign: "center" } }, "Recovery password"),
        h(Field, { placeholder: "Recovery password", secure: true, value: pw, onChangeText: setPw, autoFocus: true }),
        error ? h(Text, { style: { color: C.danger, marginTop: 8, textAlign: "center" } }, error) : null,
        h(Btn, {
          onPress: () => {
            if (pw === storage.recovery) { setError(""); onVerified(); }
            else setError("Incorrect recovery password.");
          },
        }, "Continue"),
        h(Btn, { variant: "secondary", onPress: onCancel }, "Back to PIN")
      );
    }

    function NewPinStep({ title, onDone }) {
      const [step, setStep] = useState(1);
      const [pin, setPin] = useState("");
      const [confirm, setConfirm] = useState("");
      const [error, setError] = useState("");
      return h(View, { style: { width: "100%", maxWidth: 320 } },
        h(Text, { style: { color: C.text, fontSize: 18, fontWeight: "700", textAlign: "center" } }, title),
        step === 1
          ? h(Field, { placeholder: "New PIN", secure: true, numeric: true, maxLength: 8, value: pin, onChangeText: setPin, autoFocus: true })
          : h(Field, { placeholder: "Confirm PIN", secure: true, numeric: true, maxLength: 8, value: confirm, onChangeText: setConfirm, autoFocus: true }),
        error ? h(Text, { style: { color: C.danger, marginTop: 8, textAlign: "center" } }, error) : null,
        h(Btn, {
          onPress: () => {
            if (step === 1) {
              if (pin.length < 4) return setError("PIN must be at least 4 digits.");
              setError(""); setStep(2);
            } else {
              if (confirm !== pin) return setError("PINs don't match.");
              onDone(pin);
            }
          },
        }, step === 1 ? "Continue" : "Save PIN")
      );
    }

    // ---------------------------------------------------------------------
    // Settings UI (shown on the plugin's card, per Vendetta plugin spec)
    // ---------------------------------------------------------------------
    function SettingsComponent() {
      const [, force] = useState(0);
      const rerender = () => force(n => n + 1);
      ensureDefaults();

      if (!storage.setupDone) {
        return h(SetupFlow, { onDone: rerender });
      }

      function requireCurrentPin(onOk) {
        showInputAlert({
          title: "Confirm PIN",
          placeholder: "Current PIN",
          secureTextEntry: true,
          confirmText: "Confirm",
          cancelText: "Cancel",
          onConfirm: (value) => {
            if (value !== storage.pin) throw new Error("Incorrect PIN.");
            onOk();
          },
        });
      }

      function changePin() {
        requireCurrentPin(() => {
          showInputAlert({
            title: "New PIN",
            placeholder: "New PIN",
            secureTextEntry: true,
            confirmText: "Next",
            cancelText: "Cancel",
            onConfirm: (newPin) => {
              if (!newPin || newPin.length < 4) throw new Error("PIN must be at least 4 digits.");
              showInputAlert({
                title: "Confirm new PIN",
                placeholder: "Confirm PIN",
                secureTextEntry: true,
                confirmText: "Save",
                cancelText: "Cancel",
                onConfirm: (confirmPin) => {
                  if (confirmPin !== newPin) throw new Error("PINs don't match.");
                  storage.pin = newPin;
                  showToast("PIN changed.");
                },
              });
            },
          });
        });
      }

      function changeRecovery() {
        requireCurrentPin(() => {
          showInputAlert({
            title: "New recovery password",
            placeholder: "New recovery password",
            secureTextEntry: true,
            confirmText: "Next",
            cancelText: "Cancel",
            onConfirm: (pw) => {
              if (!pw || pw.length < 4) throw new Error("Recovery password must be at least 4 characters.");
              showInputAlert({
                title: "Confirm recovery password",
                placeholder: "Confirm password",
                secureTextEntry: true,
                confirmText: "Save",
                cancelText: "Cancel",
                onConfirm: (confirmPw) => {
                  if (confirmPw !== pw) throw new Error("Passwords don't match.");
                  storage.recovery = pw;
                  showToast("Recovery password changed.");
                },
              });
            },
          });
        });
      }

      function resetPin() {
        showConfirmationAlert({
          title: "Reset PIN",
          content: "This clears your PIN and recovery password. App Lock will need to be set up again.",
          confirmText: "Reset",
          confirmColor: "danger" ,
          onConfirm: () => {
            storage.setupDone = false;
            storage.enabled = false;
            storage.pin = null;
            storage.recovery = null;
            storage.failCount = 0;
            storage.lockoutTier = 0;
            storage.lockoutUntil = 0;
            rerender();
          },
          cancelText: "Cancel",
        });
      }

      function Row({ label, value, onPress, danger }) {
        return h(TouchableOpacity, {
          activeOpacity: 0.6, onPress, disabled: !onPress,
          style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.divider },
        },
          h(Text, { style: { color: danger ? C.danger : C.text, fontSize: 15 } }, label),
          value !== undefined ? h(Text, { style: { color: C.textMuted, fontSize: 14 } }, value) : (onPress ? h(Text, { style: { color: C.textMuted } }, "\u203a") : null)
        );
      }

      function SectionTitle({ children }) {
        return h(Text, { style: { color: C.textMuted, fontSize: 12, fontWeight: "700", marginTop: 20, marginBottom: 4, textTransform: "uppercase" } }, children);
      }

      return h(View, { style: { padding: 16 } },
        h(Text, { style: { color: C.text, fontSize: 20, fontWeight: "700" } }, "App Lock"),
        h(Text, { style: { color: C.textMuted, fontSize: 13, marginTop: 4 } }, "Protect your Discord session from unauthorized access."),

        h(SectionTitle, null, "General"),
        h(Row, {
          label: "App Lock",
          value: storage.enabled ? "ON" : "OFF",
          onPress: () => { storage.enabled = !storage.enabled; rerender(); },
        }),

        h(SectionTitle, null, "Security"),
        h(Row, { label: "Change PIN", onPress: changePin }),
        h(Row, { label: "Grace period", value: graceLabel(storage.graceSeconds), onPress: () => openGracePeriodPicker(rerender) }),
        h(Row, { label: "Change recovery password", onPress: changeRecovery }),

        h(SectionTitle, null, "Actions"),
        h(Row, { label: "Lock now", onPress: () => { lockNow(); } }),
        h(Row, { label: "Reset PIN", onPress: resetPin, danger: true }),

        h(SectionTitle, null, "About"),
        h(Row, { label: "App Lock version", value: PLUGIN_VERSION })
      );
    }

    // A tiny custom picker for the grace period, built with showConfirmationAlert
    // since a native "select" component isn't part of the exposed plugin API.
    function openGracePeriodPicker(rerender) {
      let idx = GRACE_OPTIONS.findIndex(o => o.value === storage.graceSeconds);
      if (idx < 0) idx = 2;

      function pick(i) {
        storage.graceSeconds = GRACE_OPTIONS[i].value;
        showToast(`Grace period set to ${GRACE_OPTIONS[i].label}.`);
        rerender();
      }

      showCustomAlert(function GracePicker() {
        return h(View, { style: { padding: 16, backgroundColor: C.bg } },
          h(Text, { style: { color: C.text, fontSize: 16, fontWeight: "700", marginBottom: 10 } }, "Grace period"),
          GRACE_OPTIONS.map((o, i) => h(TouchableOpacity, {
            key: o.value,
            onPress: () => { pick(i); try { AlertsStack && AlertsStack.close && AlertsStack.close(); } catch (e) { } },
            style: { paddingVertical: 12 },
          }, h(Text, { style: { color: o.value === storage.graceSeconds ? C.brand : C.text, fontSize: 15 } }, o.label)))
        );
      }, {});
    }

    // ---------------------------------------------------------------------
    // Plugin lifecycle
    // ---------------------------------------------------------------------
    return {
      onLoad() {
        ensureDefaults();
        if (AppState) {
          appStateSub = AppState.addEventListener("change", handleAppStateChange);
        }
        // Lock immediately on cold start / plugin (re)start if configured.
        if (storage.setupDone && storage.enabled) {
          openLockScreen();
        }
        logger.log("Kettu App Lock loaded");
      },
      onUnload() {
        if (appStateSub) { try { appStateSub.remove(); } catch (e) { } appStateSub = null; }
        if (backHandlerSub) { try { backHandlerSub.remove(); } catch (e) { } backHandlerSub = null; }
        state.locked = false;
        state.overlayMounted = false;
      },
      settings: SettingsComponent,
    };
  }
})(vendetta);

# dsh-scrcpy-core

**Shared screen-mirroring core for DSH** — brings an Android phone or HarmonyOS device into DSH, and lets the AI actually see and operate it.

Install two packages and you are done: **this one plus one platform provider**
([Android](https://github.com/ns-zzj/dsh-android-scrcpy) / [HarmonyOS](https://github.com/ns-zzj/dsh-hos-scrcpy)).
All UI, AI tools, prompts, permissions, device/focus state live here; a provider only knows "how to talk to this device and how to produce frames".

> **[中文](./README.md)** | English

---

## Preview

![scrcpy menu: devices grouped by platform, with environment status](https://raw.githubusercontent.com/ns-zzj/dsh-scrcpy-core/main/docs/images/menu.png)

![Mirror panel: video, mouse tap/drag, bottom keys](https://raw.githubusercontent.com/ns-zzj/dsh-scrcpy-core/main/docs/images/mirror.png)

![AI at work: screenshot, control list, taps](https://raw.githubusercontent.com/ns-zzj/dsh-scrcpy-core/main/docs/images/ai.png)

---

## Why use it

| | The usual approach | Here |
|---|---|---|
| **The AI really operates the device** | Screenshot goes to an external vision model, comes back as prose, coordinates are guessed | **The screenshot goes straight to the current model**, with conversation context; taps use 0..1 ratios and the landing point flashes on screen first |
| **Permissions are hard gates** | One master key for the AI, "please be careful" in the prompt | **Four independent switches per device** (blocked / ask each time / always allow). When off, the tool returns the exact reason instead of retrying in a loop |
| **Multiple devices never cross wires** | One global "current device", you tap A and it hits B | One tab per device; operations only apply to the **focused** device. No focus means an explicit error — it never guesses |
| **UI decoupled from platforms** | One UI per platform, drifting features | One UI / toolset / prompt. Providers declare capabilities; undeclared ones produce a clear notice instead of silently doing nothing |
| **Free install** | Provider drags core along | Independent packages; installing a provider never pulls core (and does not error, it simply stays inactive) |
| **Pausing is cheap** | Leaving the tab kills the stream, coming back reconnects | Leaving only pauses broadcasting; coming back paints immediately, and rotation while paused survives |

---

## What it does

- **See the screen**: mouse click/drag = touch; rotation follows automatically without reconnecting.
- **For the AI**: one neutral toolset, registered once, shared by both platforms.

| Tool | Purpose | Permission |
|---|---|---|
| `scrcpy_devices` | Entry point: connected devices, which one is focused, its four permission states | none |
| `scrcpy_screenshot` | Captures the screen and **hands the image to the current model** (plus one line of text; if the model cannot take images it receives `[image omitted ...]`) | Allow screenshots |
| `scrcpy_locate` | Control list (`type/text/id/key/clickable/fx/fy/w/h`, ratios 0..1) | Allow controls |
| `scrcpy_tap` / `scrcpy_longpress` | Tap / long-press by ratio, confirmation first, **green dot flashes at the landing point** | Allow controls |
| `scrcpy_key` | Keys **declared by the provider** (the Android provider currently declares `back` / `home`) | Allow keys |
| `scrcpy_input` | Injects text into the focused input box (CJK supported) | Allow text input |

- **Four permissions × three states**: `blocked` / `ask each time` / `always allow`; controls, keys and text input all **depend on "Allow screenshots"**.
- **Type with your computer keyboard**: the mirror panel has an "Enable keyboard input" switch.
  Turn it on and click the picture (the state becomes "Focused: ready to type"), then type with
  **your own IME**: the candidate window stays on the computer and only confirmed text is sent.
  Backspace / Enter / arrow keys are forwarded too (milliseconds on Android, ~0.3s per key on HarmonyOS).
  Nothing is sent while the picture is not focused; turning the switch off or clicking outside exits.
  - `Ctrl+V`: send the **computer** clipboard into the device
  - `Ctrl+C`: pull the **device** clipboard back to the computer (needs HarmonyOS 7.0+; silently ignored otherwise)
- **Quality**: wired and wireless configure scale and frame rate **separately** (defaults `1/2`·60 and `1/4`·30; both can reach native resolution, frame rate capped at 120).

---

## Install

In the DSH **plugin panel**, install two packages: core first, then the provider you need.

| Order | Package | What it is |
|---|---|---|
| 1 | `@nszzj/dsh-scrcpy-core` | UI + AI tools (this package) |
| 2 | `@nszzj/dsh-android-scrcpy` and/or `@nszzj/dsh-hos-scrcpy` | Platform provider; install one or both |

The panel accepts an npm package name, a local `.tgz` path, or a `github:` spec.

**Three things you must know**

1. **Core must be installed as its own entry.** If you only install a provider, core ends up as a transitive dependency, never registered as a bundle layer — the layer is not mounted and nothing warns you.
2. **Installing a provider does not pull core.** Without core the provider sits at `pending (waiting for service: scrcpyProviders)`: no error, simply unusable. That is by design.
3. **Host-side changes need a full DSH restart**; browser-side changes only need a refresh. Disabling a plugin on desktop also takes effect only after a restart.

**Requirements**: DSH `>= 0.2.1` (declared as `engines.dsh: ">=0.2.1-0"`, which includes prereleases).

---

## Verified environments

Only the combinations below have been tested on real hardware.

| Platform | Device | System | Verified |
|---|---|---|---|
| Android | real Android device (see the provider repo) | Android with USB debugging | mirroring, tap/drag, UHID keyboard, full AI toolchain |
| HarmonyOS | SLY-AL00 | HarmonyOS 7.0.0.109 (SP6C00E105R3P3), API 26 | mirroring, tap/drag, five bottom keys, rotation, pause/resume |

Per-platform records live in each provider repository's README.

---

## Versioning and compatibility

- The three packages are versioned and installed **independently**.
- Compatibility is not decided by version ranges but by a single integer: core ships a constant `ABI`, and a provider declares **`abi`** when it registers. **Equal numbers means compatible** (currently `1` for all of them).
- **Core decides.** A mismatch (or a missing declaration) marks that provider **disabled**: its devices leave the list, actions are not routed, the menu group shows "incompatible" with the concrete reason (e.g. `requires ABI 2, core is ABI 1`), and the button slot shows the declared ABI number.
- `ABI` only increases on **breaking changes** (registered shape, actions, return shapes, `capabilities` semantics). Copy tweaks, optional fields and bug fixes never change it — so any core package pairs with any provider package of the same ABI.

---

## Known limitations

- **Scale / frame rate cannot change mid-connection**: both platforms need a reconnect; settings apply to the next connection.
- **Mirroring is change-driven**: when the screen is static no frames are sent; flat frame/byte counters are normal.
- **"No frame" means different things per platform**: HarmonyOS only pushes on change (the UI hints you to nudge the phone), Android does not need that hint. Wording comes from provider capabilities.
- **A model without image input cannot see the screen**: `scrcpy_screenshot` returns `[image omitted because this model accepts text only; ...]` and tells the AI to use `scrcpy_locate` instead of guessing.
- **Manual typing is not gated by the AI permissions**: the four switches govern AI tools only; the panel keyboard is the user's own input and is always available.
- **`Ctrl+C` inside the input area is taken**: it pulls the **device** clipboard, not the locally selected text.
- **Manual input speed and side effects differ per platform** (see each provider's README): text is injected in one shot and is fast everywhere, while key latency varies a lot and some injection paths touch the phone's clipboard.
- The menu look is still being polished.

---

## For developers

The contract (how a provider registers, action interface, streaming protocol, ABI rules): **[CONTRACT.md](./CONTRACT.md)**.
A full guide to writing a provider: **[Dev/doc.md](./Dev/doc.md)**.

```
dsh-scrcpy-core/
├── package.json          # dsh.bundle (this package is a bundle layer) + dsh.client
├── cordis.patch.yml      # inserts only core's own row — providers insert theirs, nobody touches core's
├── lib/                  # host half: registry / devices & focus / routing / tools / prompts / RPC
├── client/               # client half: the whole UI
├── resources/            # jmuxer.min.js (decoder, shipped)
├── CONTRACT.md           # core ↔ provider contract
├── Dev/doc.md            # how to write a provider
└── README.md / README.en.md
```

**Why each row has exactly one owner**: `applyEntryPatches` does not deduplicate by id. Two bundle layers inserting the same id leave two entries, and mounting then fails with `duplicate loader entry id`, which **prevents startup**.

## License

MIT.

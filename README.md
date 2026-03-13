# @oahl/adapter-android

An OAHL adapter for Android devices. Exposes screen capture, input simulation, app management, file transfer, system info, and logcat over ADB — making Android devices available as hardware capabilities to AI agents.

---

## Prerequisites

- **Node.js** >= 18
- **Android Platform Tools** (`adb`) installed and on your PATH
  - [Download here](https://developer.android.com/tools/releases/platform-tools)
- An Android device with **USB Debugging enabled** (Settings → Developer Options → USB Debugging), or a running Android emulator

Verify your setup:

```bash
adb devices
```

You should see your device listed with state `device`.

---

## Installation

```bash
npm install @oahl/adapter-android
```

---

## Usage

### Register in `oahl-config.json`

```json
{
  "adapters": [
    {
      "id": "android-adapter",
      "module": "@oahl/adapter-android"
    }
  ]
}
```

Then start your node:

```bash
oahl start
```

### Use directly in code

```ts
import AndroidAdapter from '@oahl/adapter-android';

const adapter = new AndroidAdapter();

await adapter.initialize();

const devices = await adapter.getDevices();
console.log(devices);
// [{ id: 'emulator-5554', type: 'android', name: 'Google Pixel 7 (Android 14, API 34)', isPublic: false }]

const caps = await adapter.getCapabilities(devices[0].id);

// Take a screenshot
const result = await adapter.execute(devices[0].id, 'screen.screenshot', { format: 'png' });
console.log(result.localPath); // /tmp/oahl-android-screenshots/screenshot_1234567890.png
```

### Constructor options

```ts
new AndroidAdapter({
  screenshotDir: '/your/custom/output/dir' // default: /tmp/oahl-android-screenshots
})
```

---

## Capabilities

All capabilities use JSON Schema-validated arguments. Device `id` is the ADB serial (from `adb devices`).

### `screen.screenshot`

Capture a screenshot of the device screen.

| Argument | Type | Default | Description |
|---|---|---|---|
| `format` | `"png" \| "jpg"` | `"png"` | Output image format |
| `outputPath` | `string` | auto | Local path to save the file |

```ts
await adapter.execute(deviceId, 'screen.screenshot', { format: 'png' });
// → { localPath, format, timestamp }
```

---

### `screen.record`

Record the device screen for a set duration.

| Argument | Type | Default | Description |
|---|---|---|---|
| `durationSeconds` | `integer` | `10` | Duration (1–180s) |
| `bitrateMbps` | `number` | `4` | Video bitrate in Mbps (0.5–20) |
| `outputPath` | `string` | auto | Local path to save the `.mp4` |

```ts
await adapter.execute(deviceId, 'screen.record', { durationSeconds: 15 });
// → { localPath, durationSeconds, timestamp }
```

---

### `input.tap`

Simulate a tap at screen coordinates.

| Argument | Type | Required | Description |
|---|---|---|---|
| `x` | `integer` | ✓ | X coordinate in pixels |
| `y` | `integer` | ✓ | Y coordinate in pixels |

```ts
await adapter.execute(deviceId, 'input.tap', { x: 540, y: 960 });
```

---

### `input.swipe`

Simulate a swipe gesture between two points.

| Argument | Type | Required | Description |
|---|---|---|---|
| `x1`, `y1` | `integer` | ✓ | Start coordinates |
| `x2`, `y2` | `integer` | ✓ | End coordinates |
| `durationMs` | `integer` | — | Swipe duration (50–5000ms, default 300) |

```ts
// Scroll down
await adapter.execute(deviceId, 'input.swipe', { x1: 540, y1: 1200, x2: 540, y2: 400 });
```

---

### `input.text`

Type text into the currently focused input field.

| Argument | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | ✓ | Text to type (max 1000 chars) |

```ts
await adapter.execute(deviceId, 'input.text', { text: 'hello world' });
```

---

### `input.keyevent`

Send a hardware key event.

| Argument | Type | Required | Description |
|---|---|---|---|
| `keycode` | `string` | ✓ | Keycode name or integer, e.g. `"KEYCODE_HOME"`, `"4"` |

```ts
await adapter.execute(deviceId, 'input.keyevent', { keycode: 'KEYCODE_BACK' });
```

Common keycodes: `KEYCODE_HOME` (3), `KEYCODE_BACK` (4), `KEYCODE_VOLUME_UP` (24), `KEYCODE_POWER` (26).

---

### `app.launch`

Launch an app by package name.

| Argument | Type | Required | Description |
|---|---|---|---|
| `package` | `string` | ✓ | Package name, e.g. `"com.android.settings"` |
| `activity` | `string` | — | Fully-qualified activity (optional) |

```ts
await adapter.execute(deviceId, 'app.launch', { package: 'com.android.chrome' });
```

---

### `app.stop`

Force-stop a running app.

```ts
await adapter.execute(deviceId, 'app.stop', { package: 'com.android.chrome' });
```

---

### `app.install`

Install an APK from the host machine.

| Argument | Type | Required | Description |
|---|---|---|---|
| `apkPath` | `string` | ✓ | Absolute path to the `.apk` on the host |
| `replaceExisting` | `boolean` | — | Reinstall if already installed (default `true`) |

```ts
await adapter.execute(deviceId, 'app.install', { apkPath: '/home/user/myapp.apk' });
```

---

### `app.uninstall`

Uninstall an app.

| Argument | Type | Required | Description |
|---|---|---|---|
| `package` | `string` | ✓ | Package to uninstall |
| `keepData` | `boolean` | — | Preserve app data (default `false`) |

---

### `app.list`

List installed packages.

| Argument | Type | Default | Description |
|---|---|---|---|
| `filter` | `"all" \| "system" \| "third-party" \| "enabled" \| "disabled"` | `"all"` | Which packages to return |

```ts
const { packages } = await adapter.execute(deviceId, 'app.list', { filter: 'third-party' });
```

---

### `file.push`

Push a file from the host to the device.

```ts
await adapter.execute(deviceId, 'file.push', {
  localPath: '/home/user/data.csv',
  remotePath: '/sdcard/Download/data.csv'
});
```

---

### `file.pull`

Pull a file from the device to the host.

```ts
await adapter.execute(deviceId, 'file.pull', {
  remotePath: '/sdcard/DCIM/photo.jpg',
  localPath: '/home/user/photo.jpg'
});
```

---

### `system.info`

Return system information. Sections default to `["battery", "network", "storage"]`.

| Section | Returns |
|---|---|
| `battery` | Level (%), status, plugged state |
| `network` | WiFi info, IP routes |
| `storage` | `df` output for `/sdcard` |
| `cpu` | Hardware and processor info |
| `memory` | `/proc/meminfo` top entries |
| `display` | Screen resolution and density |

```ts
const info = await adapter.execute(deviceId, 'system.info', {
  sections: ['battery', 'display']
});
```

---

### `system.shell`

Run a raw ADB shell command.

```ts
const { output } = await adapter.execute(deviceId, 'system.shell', {
  command: 'ls /sdcard'
});
```

> ⚠️ No sandboxing is applied. Use OAHL policies to restrict access to this capability in production.

---

### `logcat.dump`

Dump recent logcat output.

| Argument | Type | Default | Description |
|---|---|---|---|
| `lines` | `integer` | `200` | Number of recent lines (1–5000) |
| `filter` | `string` | `"*:V"` | Logcat filter, e.g. `"*:E"` for errors only |

```ts
const { log } = await adapter.execute(deviceId, 'logcat.dump', {
  lines: 100,
  filter: '*:E'
});
```

---

## Build

```bash
npm install
npm run build   # outputs to dist/
```

---

## License

Apache-2.0

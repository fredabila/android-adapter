import { Adapter, Device, Capability } from '@oahl/core';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// ─── Types ───────────────────────────────────────────────────────────────────

interface AndroidDevice {
  serial: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  apiLevel: string;
  isOnline: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adb(serial: string, ...args: string[]): Promise<string> {
  const cmd = `adb -s ${serial} ${args.join(' ')}`;
  try {
    const { stdout } = await execAsync(cmd);
    return stdout.trim();
  } catch (err: any) {
    throw new Error(`ADB command failed [${cmd}]: ${err.message}`);
  }
}

async function adbShell(serial: string, shellCmd: string): Promise<string> {
  return adb(serial, 'shell', shellCmd);
}

async function getAndroidDevices(): Promise<AndroidDevice[]> {
  const { stdout } = await execAsync('adb devices -l');
  const lines = stdout.split('\n').slice(1).filter(l => l.trim() && !l.startsWith('*'));
  const devices: AndroidDevice[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || state !== 'device') continue;

    try {
      const model = (await adbShell(serial, 'getprop ro.product.model')).replace(/\s+/g, '_');
      const manufacturer = await adbShell(serial, 'getprop ro.product.manufacturer');
      const androidVersion = await adbShell(serial, 'getprop ro.build.version.release');
      const apiLevel = await adbShell(serial, 'getprop ro.build.version.sdk');
      devices.push({ serial, model, manufacturer, androidVersion, apiLevel, isOnline: true });
    } catch {
      devices.push({
        serial, model: 'Unknown', manufacturer: 'Unknown',
        androidVersion: '0', apiLevel: '0', isOnline: false,
      });
    }
  }

  return devices;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class AndroidAdapter implements Adapter {
  id = 'android-adapter';

  private knownDevices: AndroidDevice[] = [];
  private outputDir: string;

  constructor(opts: { outputDir?: string } = {}) {
    this.outputDir = opts.outputDir ?? '/tmp/oahl-android';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    console.log(`[${this.id}] Initializing Android adapter…`);

    try {
      execSync('adb version', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'ADB (Android Debug Bridge) is not installed or not on PATH. ' +
        'Install Android Platform Tools: https://developer.android.com/tools/releases/platform-tools'
      );
    }

    await execAsync('adb start-server').catch(() => {});
    this.knownDevices = await getAndroidDevices();

    if (this.knownDevices.length === 0) {
      console.warn(
        `[${this.id}] No Android devices found. ` +
        'Connect a device over USB with USB debugging enabled, or start an emulator.'
      );
    } else {
      console.log(
        `[${this.id}] Found ${this.knownDevices.length} device(s): ` +
        this.knownDevices.map(d => `${d.manufacturer} ${d.model} (${d.serial})`).join(', ')
      );
    }

    fs.mkdirSync(this.outputDir, { recursive: true });
    console.log(`[${this.id}] Initialized ✓`);
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  async healthCheck(): Promise<{ status: 'ok' | 'error'; message?: string }> {
    try {
      execSync('adb version', { stdio: 'ignore' });
      const live = await getAndroidDevices();
      if (live.length === 0) return { status: 'error', message: 'No Android devices connected' };
      return { status: 'ok', message: `${live.length} device(s) online` };
    } catch (err: any) {
      return { status: 'error', message: err.message };
    }
  }

  // ── Devices ────────────────────────────────────────────────────────────────

  async getDevices(): Promise<Device[]> {
    this.knownDevices = await getAndroidDevices();
    return this.knownDevices.map(d => ({
      id: d.serial,
      type: 'android',
      name: `${d.manufacturer} ${d.model} (Android ${d.androidVersion}, API ${d.apiLevel})`,
      isPublic: false,
    }));
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  async getCapabilities(deviceId: string): Promise<Capability[]> {
    const device = this.knownDevices.find(d => d.serial === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);

    return [

      // ── Screen ──────────────────────────────────────────────────────────

      {
        name: 'screen.screenshot',
        description: 'Capture a screenshot of the device screen.',
        schema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['png', 'jpg'], default: 'png' },
            outputPath: { type: 'string', description: 'Local path to save the file.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'screen.record',
        description: 'Record the device screen for a specified duration.',
        schema: {
          type: 'object',
          properties: {
            durationSeconds: { type: 'integer', minimum: 1, maximum: 180, default: 10 },
            bitrateMbps: { type: 'number', minimum: 0.5, maximum: 20, default: 4 },
            outputPath: { type: 'string' },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── Input ────────────────────────────────────────────────────────────

      {
        name: 'input.tap',
        description: 'Simulate a tap at screen coordinates.',
        schema: {
          type: 'object',
          properties: {
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
          },
          required: ['x', 'y'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.swipe',
        description: 'Simulate a swipe gesture between two points.',
        schema: {
          type: 'object',
          properties: {
            x1: { type: 'integer', minimum: 0 },
            y1: { type: 'integer', minimum: 0 },
            x2: { type: 'integer', minimum: 0 },
            y2: { type: 'integer', minimum: 0 },
            durationMs: { type: 'integer', minimum: 50, maximum: 5000, default: 300 },
          },
          required: ['x1', 'y1', 'x2', 'y2'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.text',
        description: 'Type text into the currently focused input field.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 1000 },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.keyevent',
        description: 'Send a hardware key event (e.g. KEYCODE_HOME, KEYCODE_BACK).',
        schema: {
          type: 'object',
          properties: {
            keycode: { type: 'string', description: 'Android keycode name or integer.' },
          },
          required: ['keycode'],
          additionalProperties: false,
        },
      },

      // ── Camera / Media ────────────────────────────────────────────────────

      {
        name: 'camera.photo',
        description: 'Trigger the camera to take a photo and pull it to the host.',
        schema: {
          type: 'object',
          properties: {
            camera: { type: 'string', enum: ['back', 'front'], default: 'back' },
            outputPath: { type: 'string' },
            useIntent: { type: 'boolean', default: true, description: 'Launch camera via Android intent.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'camera.video',
        description: 'Record a video using the device camera via intent.',
        schema: {
          type: 'object',
          properties: {
            durationSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 10 },
            camera: { type: 'string', enum: ['back', 'front'], default: 'back' },
            outputPath: { type: 'string' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'camera.list',
        description: 'List available cameras and their properties.',
        schema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'media.pull_latest',
        description: 'Pull the most recently created media file (photo or video) from the device.',
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['photo', 'video', 'any'], default: 'any' },
            outputPath: { type: 'string' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'media.list',
        description: 'List media files stored on the device.',
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['photo', 'video', 'audio', 'all'], default: 'all' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
            directory: { type: 'string', default: '/sdcard/DCIM', description: 'Device directory to list.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'microphone.record',
        description: 'Record audio from the device microphone.',
        schema: {
          type: 'object',
          properties: {
            durationSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 5 },
            outputPath: { type: 'string', description: 'Local path to save the .3gp audio file.' },
            sampleRate: { type: 'integer', enum: [8000, 16000, 44100], default: 44100 },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── Notifications ─────────────────────────────────────────────────────

      {
        name: 'notification.list',
        description: 'List current active notifications on the device.',
        schema: {
          type: 'object',
          properties: {
            includeOngoing: { type: 'boolean', default: true },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'notification.send',
        description: 'Send a local notification to the device.',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 100 },
            message: { type: 'string', maxLength: 500 },
            channel: { type: 'string', default: 'default' },
          },
          required: ['title', 'message'],
          additionalProperties: false,
        },
      },
      {
        name: 'notification.dismiss_all',
        description: 'Dismiss all active notifications on the device.',
        schema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },

      // ── SMS / Calls ───────────────────────────────────────────────────────

      {
        name: 'sms.list',
        description: 'Read SMS messages from the device via content provider.',
        schema: {
          type: 'object',
          properties: {
            box: { type: 'string', enum: ['inbox', 'sent', 'draft', 'all'], default: 'inbox' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
            filter: { type: 'string', description: 'Optional phone number to filter by.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'sms.send',
        description: 'Send an SMS message from the device.',
        schema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Recipient phone number.' },
            message: { type: 'string', maxLength: 1600 },
          },
          required: ['to', 'message'],
          additionalProperties: false,
        },
      },
      {
        name: 'call.initiate',
        description: 'Initiate or dial a phone call from the device.',
        schema: {
          type: 'object',
          properties: {
            number: { type: 'string' },
            dialOnly: {
              type: 'boolean',
              default: false,
              description: 'If true, opens the dialer without placing the call.',
            },
          },
          required: ['number'],
          additionalProperties: false,
        },
      },
      {
        name: 'call.end',
        description: 'End the currently active call.',
        schema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'call.log',
        description: 'Read the call log from the device.',
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['incoming', 'outgoing', 'missed', 'all'], default: 'all' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── Sensors ───────────────────────────────────────────────────────────

      {
        name: 'sensor.gps',
        description: 'Get the current GPS location of the device.',
        schema: {
          type: 'object',
          properties: {
            timeoutSeconds: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
            provider: { type: 'string', enum: ['gps', 'network', 'passive'], default: 'gps' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'sensor.accelerometer',
        description: 'Read accelerometer data (X, Y, Z axes in m/s²).',
        schema: {
          type: 'object',
          properties: {
            samples: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            intervalMs: { type: 'integer', minimum: 10, maximum: 1000, default: 100 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'sensor.gyroscope',
        description: 'Read gyroscope data (rotation rate on X, Y, Z axes in rad/s).',
        schema: {
          type: 'object',
          properties: {
            samples: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            intervalMs: { type: 'integer', minimum: 10, maximum: 1000, default: 100 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'sensor.light',
        description: 'Read ambient light level from the device light sensor (in lux).',
        schema: {
          type: 'object',
          properties: {
            samples: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
            intervalMs: { type: 'integer', minimum: 100, maximum: 2000, default: 500 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'sensor.battery',
        description: 'Read detailed battery sensor data: temperature, voltage, health, and charge level.',
        schema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'sensor.list',
        description: 'List all hardware sensors available on the device.',
        schema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },

      // ── App ──────────────────────────────────────────────────────────────

      {
        name: 'app.launch',
        description: 'Launch an app by package name.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string' },
            activity: { type: 'string', description: 'Optional fully-qualified activity name.' },
          },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.stop',
        description: 'Force-stop a running app.',
        schema: {
          type: 'object',
          properties: { package: { type: 'string' } },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.install',
        description: 'Install an APK from the host machine onto the device.',
        schema: {
          type: 'object',
          properties: {
            apkPath: { type: 'string' },
            replaceExisting: { type: 'boolean', default: true },
          },
          required: ['apkPath'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.uninstall',
        description: 'Uninstall an app by package name.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string' },
            keepData: { type: 'boolean', default: false },
          },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.list',
        description: 'List installed packages on the device.',
        schema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              enum: ['all', 'system', 'third-party', 'enabled', 'disabled'],
              default: 'all',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── Files ────────────────────────────────────────────────────────────

      {
        name: 'file.push',
        description: 'Push a file from the host to the device.',
        schema: {
          type: 'object',
          properties: {
            localPath: { type: 'string' },
            remotePath: { type: 'string' },
          },
          required: ['localPath', 'remotePath'],
          additionalProperties: false,
        },
      },
      {
        name: 'file.pull',
        description: 'Pull a file from the device to the host.',
        schema: {
          type: 'object',
          properties: {
            remotePath: { type: 'string' },
            localPath: { type: 'string' },
          },
          required: ['remotePath', 'localPath'],
          additionalProperties: false,
        },
      },

      // ── System ───────────────────────────────────────────────────────────

      {
        name: 'system.info',
        description: 'Return device system information (battery, network, storage, CPU, memory, display).',
        schema: {
          type: 'object',
          properties: {
            sections: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['battery', 'network', 'storage', 'cpu', 'memory', 'display'],
              },
              default: ['battery', 'network', 'storage'],
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'system.shell',
        description: 'Execute a raw shell command on the device. Use OAHL policies to restrict access.',
        schema: {
          type: 'object',
          properties: {
            command: { type: 'string', maxLength: 2048 },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },

      // ── Logcat ───────────────────────────────────────────────────────────

      {
        name: 'logcat.dump',
        description: 'Dump recent logcat output.',
        schema: {
          type: 'object',
          properties: {
            lines: { type: 'integer', minimum: 1, maximum: 5000, default: 200 },
            filter: { type: 'string', description: 'Logcat filter expression e.g. "*:E".' },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── UI Inspection ─────────────────────────────────────────────────────

      {
        name: 'ui.dump',
        description: 'Dump the full UI hierarchy XML of the current screen using UIAutomator. Returns every visible element with bounds, text, resource-id, class, enabled, focused, clickable, scrollable, checked, and selected attributes. Use this to understand what is on screen before interacting.',
        schema: {
          type: 'object',
          properties: {
            compressed: { type: 'boolean', default: false, description: 'Omit redundant non-leaf nodes.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.find',
        description: 'Find elements in the current UI hierarchy. Returns matching elements with bounds, text, resource-id, class, and interaction flags.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Exact text match.' },
            textContains: { type: 'string', description: 'Partial text match (case-insensitive).' },
            resourceId: { type: 'string', description: 'Resource ID e.g. "com.app:id/submit".' },
            className: { type: 'string', description: 'UI class e.g. "android.widget.EditText".' },
            contentDesc: { type: 'string', description: 'Accessibility label.' },
            index: { type: 'integer', description: 'Return the Nth match (0-based). Omit for all.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.current_app',
        description: 'Return the package name and activity currently in the foreground.',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'ui.current_activity',
        description: 'Return full details about the foreground activity: task stack, resumed activity, window info.',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'ui.get_text',
        description: 'Read the current text value of an input field or element.',
        schema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string' },
            text: { type: 'string', description: 'Identify by current text.' },
            contentDesc: { type: 'string' },
            index: { type: 'integer', default: 0 },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── UI Interaction ────────────────────────────────────────────────────

      {
        name: 'ui.tap_element',
        description: 'Tap an element by text, resource-id, content description, or class. Resolves coordinates automatically.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            textContains: { type: 'string' },
            resourceId: { type: 'string' },
            className: { type: 'string' },
            contentDesc: { type: 'string' },
            index: { type: 'integer', default: 0 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.long_press_element',
        description: 'Long-press an element by text, resource-id, or content description.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            textContains: { type: 'string' },
            resourceId: { type: 'string' },
            contentDesc: { type: 'string' },
            index: { type: 'integer', default: 0 },
            durationMs: { type: 'integer', minimum: 500, maximum: 10000, default: 1000 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'input.long_press',
        description: 'Long-press at specific screen coordinates.',
        schema: {
          type: 'object',
          properties: {
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
            durationMs: { type: 'integer', minimum: 500, maximum: 10000, default: 1000 },
          },
          required: ['x', 'y'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.double_tap',
        description: 'Double-tap at specific screen coordinates.',
        schema: {
          type: 'object',
          properties: {
            x: { type: 'integer', minimum: 0 },
            y: { type: 'integer', minimum: 0 },
            intervalMs: { type: 'integer', minimum: 50, maximum: 500, default: 100 },
          },
          required: ['x', 'y'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.drag',
        description: 'Drag from one coordinate to another.',
        schema: {
          type: 'object',
          properties: {
            x1: { type: 'integer', minimum: 0 },
            y1: { type: 'integer', minimum: 0 },
            x2: { type: 'integer', minimum: 0 },
            y2: { type: 'integer', minimum: 0 },
            durationMs: { type: 'integer', minimum: 100, maximum: 10000, default: 500 },
          },
          required: ['x1', 'y1', 'x2', 'y2'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.pinch',
        description: 'Pinch in or out at a center point.',
        schema: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            direction: { type: 'string', enum: ['in', 'out'], default: 'out' },
            percent: { type: 'integer', minimum: 10, maximum: 100, default: 50 },
            durationMs: { type: 'integer', minimum: 100, maximum: 3000, default: 500 },
          },
          required: ['x', 'y'],
          additionalProperties: false,
        },
      },

      // ── Text Editing ──────────────────────────────────────────────────────

      {
        name: 'ui.clear_text',
        description: 'Clear all text from a focused input field using select-all + delete.',
        schema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string', description: 'Tap and focus this field first.' },
            text: { type: 'string', description: 'Identify field by current text.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.clear_and_type',
        description: 'Clear an input field and type new text. Most reliable way to fill form fields.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 2000, description: 'Text to type after clearing.' },
            resourceId: { type: 'string', description: 'Target field by resource-id.' },
            fieldText: { type: 'string', description: 'Target field by its current text.' },
            tapFirst: { type: 'boolean', default: true },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },

      // ── Waiting ───────────────────────────────────────────────────────────

      {
        name: 'ui.wait_for_element',
        description: 'Poll UI hierarchy until a matching element appears. Use after navigation or taps that trigger loading.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            textContains: { type: 'string' },
            resourceId: { type: 'string' },
            className: { type: 'string' },
            contentDesc: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, default: 5000 },
            intervalMs: { type: 'integer', minimum: 100, maximum: 2000, default: 500 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.wait_for_gone',
        description: 'Poll until an element disappears (e.g. a loading spinner). Returns true when gone.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            textContains: { type: 'string' },
            resourceId: { type: 'string' },
            contentDesc: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, default: 5000 },
            intervalMs: { type: 'integer', minimum: 100, maximum: 2000, default: 500 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.wait_for_activity',
        description: 'Wait until a specific package or activity is in the foreground.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string' },
            activity: { type: 'string', description: 'Partial activity name match.' },
            timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, default: 5000 },
            intervalMs: { type: 'integer', minimum: 100, maximum: 2000, default: 500 },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── Scrolling ─────────────────────────────────────────────────────────

      {
        name: 'ui.scroll_to',
        description: 'Swipe repeatedly until an element with matching text or resource-id is visible.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            textContains: { type: 'string' },
            resourceId: { type: 'string' },
            direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], default: 'down' },
            maxSwipes: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
            swipeDurationMs: { type: 'integer', minimum: 100, maximum: 2000, default: 400 },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.scroll',
        description: 'Scroll the screen or a scrollable container.',
        schema: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], default: 'down' },
            times: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
            resourceId: { type: 'string', description: 'Scroll inside this container.' },
            durationMs: { type: 'integer', minimum: 100, maximum: 2000, default: 400 },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── Dialog Handling ───────────────────────────────────────────────────

      {
        name: 'ui.dismiss_dialog',
        description: 'Dismiss any active dialog or popup. Tries Back key, then common dismiss buttons.',
        schema: {
          type: 'object',
          properties: {
            preferButton: { type: 'string', description: 'Try this button text first.' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.handle_permission_dialog',
        description: 'Handle an Android permission dialog by allowing or denying it.',
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['allow', 'deny', 'allow_once', 'allow_always'], default: 'allow' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'ui.check_dialog',
        description: 'Check if any dialog or popup is visible. Returns dialog type and available buttons.',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },

      // ── App Extras ────────────────────────────────────────────────────────

      {
        name: 'app.current',
        description: 'Return the foreground package and activity.',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'app.clear_data',
        description: 'Clear all data and cache for an app.',
        schema: {
          type: 'object',
          properties: { package: { type: 'string' } },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.info',
        description: 'Return version, install date, data size, permissions, and enabled state of an app.',
        schema: {
          type: 'object',
          properties: { package: { type: 'string' } },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.permissions.list',
        description: 'List all permissions declared and granted for an app.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string' },
            grantedOnly: { type: 'boolean', default: false },
          },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.permissions.grant',
        description: 'Grant a runtime permission to an app.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string' },
            permission: { type: 'string', description: 'e.g. "android.permission.CAMERA"' },
          },
          required: ['package', 'permission'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.permissions.revoke',
        description: 'Revoke a runtime permission from an app.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string' },
            permission: { type: 'string' },
          },
          required: ['package', 'permission'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.broadcast',
        description: 'Send an arbitrary broadcast intent.',
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            package: { type: 'string' },
            extras: { type: 'object', additionalProperties: { type: 'string' } },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },

      // ── System Extras ─────────────────────────────────────────────────────

      {
        name: 'system.clipboard.set',
        description: 'Set the device clipboard content.',
        schema: {
          type: 'object',
          properties: { text: { type: 'string', maxLength: 10000 } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      {
        name: 'system.clipboard.get',
        description: 'Get current clipboard content.',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'system.wake',
        description: 'Wake the device screen.',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'system.lock',
        description: 'Lock the device screen.',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        name: 'system.rotate',
        description: 'Set screen orientation.',
        schema: {
          type: 'object',
          properties: {
            orientation: { type: 'string', enum: ['portrait', 'landscape', 'auto'], default: 'portrait' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'system.volume',
        description: 'Set device volume for a specific stream.',
        schema: {
          type: 'object',
          properties: {
            stream: { type: 'string', enum: ['music', 'ring', 'notification', 'alarm', 'call'], default: 'music' },
            level: { type: 'integer', minimum: 0, maximum: 15 },
            mute: { type: 'boolean' },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'system.wifi',
        description: 'Enable or disable WiFi.',
        schema: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
          required: ['enabled'],
          additionalProperties: false,
        },
      },
      {
        name: 'system.airplane_mode',
        description: 'Enable or disable airplane mode.',
        schema: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
          required: ['enabled'],
          additionalProperties: false,
        },
      },
      {
        name: 'system.setting.get',
        description: 'Read a system/secure/global setting.',
        schema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', enum: ['system', 'secure', 'global'], default: 'system' },
            key: { type: 'string' },
          },
          required: ['key'],
          additionalProperties: false,
        },
      },
      {
        name: 'system.setting.set',
        description: 'Write a system/secure/global setting.',
        schema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', enum: ['system', 'secure', 'global'], default: 'system' },
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key', 'value'],
          additionalProperties: false,
        },
      },
      {
        name: 'system.props',
        description: 'Read system properties via getprop.',
        schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Specific prop key. Omit to return all.' },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── File Extras ───────────────────────────────────────────────────────

      {
        name: 'file.list',
        description: 'List files and directories at a path on the device.',
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', default: '/sdcard/' },
            recursive: { type: 'boolean', default: false },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'file.delete',
        description: 'Delete a file or directory on the device.',
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            recursive: { type: 'boolean', default: false },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'file.exists',
        description: 'Check whether a file or directory exists on the device.',
        schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        name: 'file.read',
        description: 'Read text content of a file on the device.',
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            maxBytes: { type: 'integer', minimum: 1, maximum: 1048576, default: 65536 },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ];
  }

  // ── Execute ───────────────────────────────────────────────────────────────

  async execute(deviceId: string, capabilityName: string, args: any): Promise<any> {
    const device = this.knownDevices.find(d => d.serial === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);

    const ts = () => Date.now();
    const outFile = (name: string, ext: string) =>
      path.join(this.outputDir, `${name}_${ts()}.${ext}`);
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    switch (capabilityName) {

      // ── Screen ────────────────────────────────────────────────────────────

      case 'screen.screenshot': {
        const fmt = args.format ?? 'png';
        const remote = `/sdcard/oahl_ss_${ts()}.png`;
        const local = args.outputPath ?? outFile('screenshot', fmt);
        await adbShell(deviceId, `screencap -p ${remote}`);
        await adb(deviceId, 'pull', remote, local);
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});
        return { localPath: local, format: fmt, timestamp: new Date().toISOString() };
      }

      case 'screen.record': {
        const duration = args.durationSeconds ?? 10;
        const bitrate = Math.round((args.bitrateMbps ?? 4) * 1_000_000);
        const remote = `/sdcard/oahl_rec_${ts()}.mp4`;
        const local = args.outputPath ?? outFile('screenrecord', 'mp4');
        await execAsync(`adb -s ${deviceId} shell screenrecord --time-limit ${duration} --bit-rate ${bitrate} ${remote}`);
        await adb(deviceId, 'pull', remote, local);
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});
        return { localPath: local, durationSeconds: duration, timestamp: new Date().toISOString() };
      }

      // ── Input ─────────────────────────────────────────────────────────────

      case 'input.tap':
        await adbShell(deviceId, `input tap ${args.x} ${args.y}`);
        return { tapped: { x: args.x, y: args.y } };

      case 'input.swipe': {
        const dur = args.durationMs ?? 300;
        await adbShell(deviceId, `input swipe ${args.x1} ${args.y1} ${args.x2} ${args.y2} ${dur}`);
        return { swipe: { from: [args.x1, args.y1], to: [args.x2, args.y2], durationMs: dur } };
      }

      case 'input.text': {
        const escaped = args.text
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\' ")
          .replace(/ /g, '%s')
          .replace(/"/g, '\\"');
        await adbShell(deviceId, `input text '${escaped}'`);
        return { typed: args.text };
      }
      

      case 'input.keyevent':
        await adbShell(deviceId, `input keyevent ${args.keycode}`);
        return { keycode: args.keycode };

      // ── Camera / Media ────────────────────────────────────────────────────

      case 'camera.photo': {
        const cameraFacing = args.camera === 'front' ? '1' : '0';
        const local = args.outputPath ?? outFile('photo', 'jpg');

        await adbShell(
          deviceId,
          `am start --user 0 -a android.media.action.STILL_IMAGE_CAMERA --ei android.intent.extras.CAMERA_FACING ${cameraFacing}`
        );
        await sleep(2000);
        await adbShell(deviceId, 'input keyevent KEYCODE_CAMERA');
        await sleep(1500);

        const latest = await adbShell(deviceId, 'ls -t /sdcard/DCIM/Camera/ | head -1').catch(() => '');
        if (latest.trim()) {
          const remoteLatest = `/sdcard/DCIM/Camera/${latest.trim()}`;
          await adb(deviceId, 'pull', remoteLatest, local);
          return { localPath: local, source: remoteLatest, timestamp: new Date().toISOString() };
        }

        // Fallback: screencap of viewfinder
        const remote = `/sdcard/oahl_photo_${ts()}.png`;
        await adbShell(deviceId, `screencap -p ${remote}`);
        await adb(deviceId, 'pull', remote, local);
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});
        return { localPath: local, note: 'Captured via screencap fallback', timestamp: new Date().toISOString() };
      }

      case 'camera.video': {
        const duration = args.durationSeconds ?? 10;
        const local = args.outputPath ?? outFile('video', 'mp4');
        const cameraFacing = args.camera === 'front' ? '1' : '0';

        await adbShell(
          deviceId,
          `am start --user 0 -a android.media.action.VIDEO_CAPTURE --ei android.intent.extras.CAMERA_FACING ${cameraFacing}`
        );
        await sleep(2000);
        await adbShell(deviceId, 'input keyevent KEYCODE_CAMERA'); // start
        await sleep(duration * 1000);
        await adbShell(deviceId, 'input keyevent KEYCODE_CAMERA'); // stop
        await sleep(1500);

        const latest = await adbShell(
          deviceId,
          'ls -t /sdcard/DCIM/Camera/*.mp4 2>/dev/null | head -1'
        ).catch(() => '');
        if (latest.trim()) {
          await adb(deviceId, 'pull', latest.trim(), local);
          return { localPath: local, durationSeconds: duration, timestamp: new Date().toISOString() };
        }
        throw new Error('Video capture failed — no .mp4 found in /sdcard/DCIM/Camera/');
      }

      case 'camera.list': {
        const raw = await adbShell(
          deviceId,
          'dumpsys media.camera | grep -E "Camera ID|Facing|Flash|Resolutions" | head -30'
        ).catch(() => '');
        return { cameras: raw.trim().split('\n').map(l => l.trim()).filter(Boolean) };
      }

      case 'media.pull_latest': {
        const type = args.type ?? 'any';
        const glob = type === 'video'
          ? '/sdcard/DCIM/Camera/*.mp4'
          : type === 'photo'
          ? '/sdcard/DCIM/Camera/*.jpg'
          : '/sdcard/DCIM/Camera/*';

        const latest = await adbShell(deviceId, `ls -t ${glob} 2>/dev/null | head -1`).catch(() => '');
        if (!latest.trim()) throw new Error('No media found in /sdcard/DCIM/Camera/');
        const filename = path.basename(latest.trim());
        const local = args.outputPath ?? path.join(this.outputDir, filename);
        await adb(deviceId, 'pull', latest.trim(), local);
        return { localPath: local, remotePath: latest.trim(), timestamp: new Date().toISOString() };
      }

      case 'media.list': {
        const dir = args.directory ?? '/sdcard/DCIM';
        const limit = args.limit ?? 20;
        const raw = await adbShell(deviceId, `find ${dir} -type f | head -${limit}`).catch(() => '');
        const files = raw.split('\n').map(l => l.trim()).filter(Boolean);
        return { files, count: files.length, directory: dir };
      }

      case 'microphone.record': {
        const duration = args.durationSeconds ?? 5;
        const local = args.outputPath ?? outFile('audio', '3gp');
        const remote = `/sdcard/oahl_audio_${ts()}.3gp`;

        // Try screenrecord with --audio (Android 10+)
        const recorded = await execAsync(
          `adb -s ${deviceId} shell screenrecord --time-limit ${duration} --audio ${remote}`
        ).then(() => true).catch(() => false);

        if (!recorded) {
          throw new Error(
            'Microphone recording requires a companion app or Android 10+ with --audio support. ' +
            'Consider using camera.video which captures audio on most devices.'
          );
        }

        await sleep((duration + 1) * 1000);
        await adb(deviceId, 'pull', remote, local);
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});
        return { localPath: local, durationSeconds: duration, timestamp: new Date().toISOString() };
      }

      // ── Notifications ─────────────────────────────────────────────────────

      case 'notification.list': {
        const raw = await adbShell(
          deviceId,
          'dumpsys notification --noredact 2>/dev/null | grep -E "NotificationRecord|pkg=|title=|text=" | head -100'
        ).catch(() => '');

        const notifications: any[] = [];
        let current: any = {};
        for (const line of raw.split('\n').map(l => l.trim()).filter(Boolean)) {
          if (line.startsWith('NotificationRecord')) {
            if (current.pkg) notifications.push(current);
            current = {};
          } else if (line.includes('pkg=')) {
            current.pkg = line.match(/pkg=([^\s,]+)/)?.[1];
          } else if (line.includes('title=')) {
            current.title = line.match(/title=(.+)/)?.[1]?.trim();
          } else if (line.includes('text=')) {
            current.text = line.match(/text=(.+)/)?.[1]?.trim();
          }
        }
        if (current.pkg) notifications.push(current);

        return { notifications, count: notifications.length };
      }

      case 'notification.send': {
        const { title, message } = args;
        // cmd notification is available on API 28+
        await adbShell(
          deviceId,
          `cmd notification post --user 0 -S bigtext -t "${title}" oahl_channel "${message}"`
        ).catch(async () => {
          await adbShell(
            deviceId,
            `am broadcast --user 0 -a oahl.ACTION_NOTIFY --es title "${title}" --es message "${message}"`
          );
        });
        return { sent: true, title, message, timestamp: new Date().toISOString() };
      }

      case 'notification.dismiss_all':
        await adbShell(deviceId, 'service call notification 1');
        return { dismissed: true, timestamp: new Date().toISOString() };

      // ── SMS / Calls ───────────────────────────────────────────────────────

      case 'sms.list': {
        const box = args.box ?? 'inbox';
        const limit = args.limit ?? 20;
        const boxPath = box !== 'all' ? box : '';
        const whereFilter = args.filter ? `--where "address='${args.filter}'"` : '';

        const raw = await adbShell(
          deviceId,
          `content query --user 0 --uri content://sms/${boxPath} --projection _id,address,body,date,type --limit ${limit} ${whereFilter}`
        ).catch(() => '');

        const messages = raw.split('\n')
          .filter(l => l.includes('Row:'))
          .map(row => {
            const get = (k: string) => row.match(new RegExp(`${k}=([^,\\n]+)`))?.[1]?.trim() ?? '';
            return {
              id: get('_id'),
              address: get('address'),
              body: get('body'),
              date: new Date(parseInt(get('date') || '0')).toISOString(),
              type: get('type'),
            };
          });

        return { messages, count: messages.length, box };
      }

      case 'sms.send': {
        const { to, message } = args;
        await adbShell(
          deviceId,
          `am start --user 0 -a android.intent.action.SENDTO -d "sms:${to}" --es sms_body "${message}" --ez exit_on_sent true`
        );
        await sleep(1500);
        // Attempt to trigger send button
        await adbShell(deviceId, 'input keyevent KEYCODE_ENTER').catch(() => {});
        return { sent: true, to, timestamp: new Date().toISOString() };
      }

      case 'call.initiate': {
        const action = args.dialOnly
          ? 'android.intent.action.DIAL'
          : 'android.intent.action.CALL';
        await adbShell(deviceId, `am start --user 0 -a ${action} -d "tel:${args.number}"`);
        return { initiated: true, number: args.number, dialOnly: args.dialOnly ?? false, timestamp: new Date().toISOString() };
      }

      case 'call.end':
        await adbShell(deviceId, 'input keyevent KEYCODE_ENDCALL');
        return { ended: true, timestamp: new Date().toISOString() };

      case 'call.log': {
        const type = args.type ?? 'all';
        const limit = args.limit ?? 20;
        const typeMap: Record<string, number> = { incoming: 1, outgoing: 2, missed: 3 };
        const whereClause = typeMap[type] ? `--where "type=${typeMap[type]}"` : '';

        const raw = await adbShell(
          deviceId,
          `content query --user 0 --uri content://call_log/calls --projection number,date,duration,type --limit ${limit} ${whereClause}`
        ).catch(() => '');

        const callTypeLabel: Record<string, string> = { '1': 'incoming', '2': 'outgoing', '3': 'missed' };
        const calls = raw.split('\n')
          .filter(l => l.includes('Row:'))
          .map(row => {
            const get = (k: string) => row.match(new RegExp(`${k}=([^,\\n]+)`))?.[1]?.trim() ?? '';
            return {
              number: get('number'),
              date: new Date(parseInt(get('date') || '0')).toISOString(),
              durationSeconds: parseInt(get('duration') || '0'),
              type: callTypeLabel[get('type')] ?? get('type'),
            };
          });

        return { calls, count: calls.length, filter: type };
      }

      // ── Sensors ───────────────────────────────────────────────────────────

      case 'sensor.gps': {
        const raw = await adbShell(
          deviceId,
          'dumpsys location | grep -A 10 "Last Known Locations" | head -20'
        ).catch(() => '');

        const lat = raw.match(/latitude=([0-9.\-]+)/)?.[1];
        const lng = raw.match(/longitude=([0-9.\-]+)/)?.[1];
        const acc = raw.match(/accuracy=([0-9.]+)/)?.[1];
        const alt = raw.match(/altitude=([0-9.\-]+)/)?.[1];

        if (lat && lng) {
          return {
            latitude: parseFloat(lat),
            longitude: parseFloat(lng),
            accuracy: acc ? parseFloat(acc) : null,
            altitude: alt ? parseFloat(alt) : null,
            provider: args.provider ?? 'gps',
            timestamp: new Date().toISOString(),
          };
        }

        const fallback = await adbShell(
          deviceId, 'dumpsys gps | grep -E "lat|lon|fix" | head -10'
        ).catch(() => '');
        return { raw: fallback.trim(), note: 'Could not parse structured GPS data', timestamp: new Date().toISOString() };
      }

      case 'sensor.accelerometer': {
        const samples = args.samples ?? 10;
        const intervalMs = args.intervalMs ?? 100;
        const readings: any[] = [];

        for (let i = 0; i < samples; i++) {
          const raw = await adbShell(
            deviceId,
            'dumpsys sensorservice | grep -A 3 -i "Accelerometer" | head -6'
          ).catch(() => '');
          readings.push({
            sample: i + 1,
            x: raw.match(/x=([0-9.\-]+)/)?.[1] ? parseFloat(raw.match(/x=([0-9.\-]+)/)![1]) : null,
            y: raw.match(/y=([0-9.\-]+)/)?.[1] ? parseFloat(raw.match(/y=([0-9.\-]+)/)![1]) : null,
            z: raw.match(/z=([0-9.\-]+)/)?.[1] ? parseFloat(raw.match(/z=([0-9.\-]+)/)![1]) : null,
            timestamp: new Date().toISOString(),
          });
          if (i < samples - 1) await sleep(intervalMs);
        }

        return { sensor: 'accelerometer', unit: 'm/s²', readings };
      }

      case 'sensor.gyroscope': {
        const samples = args.samples ?? 10;
        const intervalMs = args.intervalMs ?? 100;
        const readings: any[] = [];

        for (let i = 0; i < samples; i++) {
          const raw = await adbShell(
            deviceId,
            'dumpsys sensorservice | grep -A 3 -i "Gyroscope" | head -6'
          ).catch(() => '');
          readings.push({
            sample: i + 1,
            x: raw.match(/x=([0-9.\-]+)/)?.[1] ? parseFloat(raw.match(/x=([0-9.\-]+)/)![1]) : null,
            y: raw.match(/y=([0-9.\-]+)/)?.[1] ? parseFloat(raw.match(/y=([0-9.\-]+)/)![1]) : null,
            z: raw.match(/z=([0-9.\-]+)/)?.[1] ? parseFloat(raw.match(/z=([0-9.\-]+)/)![1]) : null,
            timestamp: new Date().toISOString(),
          });
          if (i < samples - 1) await sleep(intervalMs);
        }

        return { sensor: 'gyroscope', unit: 'rad/s', readings };
      }

      case 'sensor.light': {
        const samples = args.samples ?? 5;
        const intervalMs = args.intervalMs ?? 500;
        const readings: any[] = [];

        for (let i = 0; i < samples; i++) {
          const raw = await adbShell(
            deviceId,
            'dumpsys sensorservice | grep -A 3 -i "light" | head -6'
          ).catch(() => '');
          const lux = raw.match(/value=([0-9.]+)/)?.[1] ?? raw.match(/([0-9]+\.?[0-9]*)\s*lux/i)?.[1];
          readings.push({
            sample: i + 1,
            lux: lux ? parseFloat(lux) : null,
            timestamp: new Date().toISOString(),
          });
          if (i < samples - 1) await sleep(intervalMs);
        }

        return { sensor: 'light', unit: 'lux', readings };
      }

      case 'sensor.battery': {
        const raw = await adbShell(deviceId, 'dumpsys battery');
        const get = (key: string) => raw.match(new RegExp(`${key}:\\s*([^\\n]+)`))?.[1]?.trim();
        return {
          level: get('level') ? parseInt(get('level')!) : null,
          status: get('status'),
          health: get('health'),
          present: get('present'),
          scale: get('scale'),
          voltage: get('voltage') ? parseInt(get('voltage')!) : null,
          temperatureCelsius: get('temperature') ? parseInt(get('temperature')!) / 10 : null,
          technology: get('technology'),
          plugged: get('plugged'),
          timestamp: new Date().toISOString(),
        };
      }

      case 'sensor.list': {
        const raw = await adbShell(
          deviceId,
          'dumpsys sensorservice | grep -E "^[0-9]+ \\)" | head -50'
        ).catch(() => '');
        const sensors = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ description: l }));
        return { sensors, count: sensors.length };
      }

      // ── App ───────────────────────────────────────────────────────────────

      case 'app.launch': {
        if (args.activity) {
          await adbShell(deviceId, `am start --user 0 -n ${args.package}/${args.activity}`);
        } else {
          // Strategy 1: dumpsys package to find the real MAIN/LAUNCHER activity
          let launched = false;
          try {
            const dump = await adbShell(deviceId, `dumpsys package ${args.package} | grep -A2 "android.intent.action.MAIN" | grep "${args.package}" | head -1`);
            const component = dump.trim().split(/\s+/).find(t => t.includes('/'));
            if (component) {
              await adbShell(deviceId, `am start --user 0 -n ${component}`);
              launched = true;
            }
          } catch { /* fall through */ }

          // Strategy 2: cmd package resolve-activity
          if (!launched) {
            try {
              const resolved = await adbShell(
                deviceId,
                `cmd package resolve-activity --user 0 --brief -c android.intent.category.LAUNCHER -a android.intent.action.MAIN ${args.package} 2>/dev/null | grep "/" | tail -1`
              );
              if (resolved.trim() && !resolved.includes('No activity') && resolved.includes('/')) {
                await adbShell(deviceId, `am start --user 0 -n ${resolved.trim()}`);
                launched = true;
              }
            } catch { /* fall through */ }
          }

          // Strategy 3: plain am start with package only — Android resolves it
          if (!launched) {
            await adbShell(deviceId,
              `am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${args.package}`
            );
          }
        }
        return { launched: args.package };
      }

      case 'app.stop':
        await adbShell(deviceId, `am force-stop --user 0 ${args.package}`);
        return { stopped: args.package };

      case 'app.install': {
        const flag = args.replaceExisting !== false ? '-r' : '';
        await execAsync(`adb -s ${deviceId} install ${flag} --user 0 "${args.apkPath}"`);
        return { installed: args.apkPath };
      }

      case 'app.uninstall': {
        const flag = args.keepData ? '-k' : '';
        await execAsync(`adb -s ${deviceId} uninstall ${flag} --user 0 ${args.package}`);
        return { uninstalled: args.package };
      }

      case 'app.list': {
        const filterMap: Record<string, string> = {
          all: '', system: '-s', 'third-party': '-3', enabled: '-e', disabled: '-d',
        };
        const flag = filterMap[args.filter ?? 'all'] ?? '';
        const raw = await adbShell(deviceId, `pm list packages --user 0 ${flag}`);
        const packages = raw.split('\n').map(l => l.replace(/^package:/, '').trim()).filter(Boolean);
        return { packages, count: packages.length };
      }

      // ── Files ─────────────────────────────────────────────────────────────

      case 'file.push':
        await execAsync(`adb -s ${deviceId} push "${args.localPath}" "${args.remotePath}"`);
        return { pushed: { from: args.localPath, to: args.remotePath } };

      case 'file.pull':
        await execAsync(`adb -s ${deviceId} pull "${args.remotePath}" "${args.localPath}"`);
        return { pulled: { from: args.remotePath, to: args.localPath } };

      // ── System ────────────────────────────────────────────────────────────

      case 'system.info': {
        const sections: string[] = args.sections ?? ['battery', 'network', 'storage'];
        const result: Record<string, any> = {};

        if (sections.includes('battery')) {
          const raw = await adbShell(deviceId, 'dumpsys battery');
          result.battery = {
            level: parseInt(raw.match(/level:\s*(\d+)/)?.[1] ?? '0'),
            status: raw.match(/status:\s*(\d+)/)?.[1],
            plugged: raw.match(/plugged:\s*(\d+)/)?.[1],
          };
        }
        if (sections.includes('network')) {
          const wifi = await adbShell(deviceId, 'dumpsys wifi | grep "mNetworkInfo"').catch(() => '');
          const ip = await adbShell(deviceId, 'ip route').catch(() => '');
          result.network = { wifiInfo: wifi.trim(), routes: ip.trim() };
        }
        if (sections.includes('storage')) {
          result.storage = { df: (await adbShell(deviceId, 'df /sdcard')).trim() };
        }
        if (sections.includes('cpu')) {
          result.cpu = { info: (await adbShell(deviceId, 'cat /proc/cpuinfo | grep "Hardware\\|model name\\|processor" | head -10')).trim() };
        }
        if (sections.includes('memory')) {
          result.memory = { info: (await adbShell(deviceId, 'cat /proc/meminfo | head -5')).trim() };
        }
        if (sections.includes('display')) {
          result.display = { info: (await adbShell(deviceId, 'wm size && wm density')).trim() };
        }

        return result;
      }

      case 'system.shell': {
        const output = await adbShell(deviceId, args.command);
        return { output, command: args.command };
      }

      // ── Logcat ────────────────────────────────────────────────────────────

      case 'logcat.dump': {
        const lines = args.lines ?? 200;
        const filter = args.filter ?? '*:V';
        const raw = await execAsync(`adb -s ${deviceId} logcat -d -t ${lines} ${filter}`)
          .then(r => r.stdout).catch(e => e.stdout ?? '');
        return { log: raw.trim(), lines: raw.trim().split('\n').length };
      }


      // ── UI Inspection ─────────────────────────────────────────────────────

      case 'ui.dump': {
        const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
        await adbShell(deviceId, `uiautomator dump ${args.compressed ? '--compressed' : ''} ${remote}`);
        const xml = await adbShell(deviceId, `cat ${remote}`);
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});
        return { xml, timestamp: new Date().toISOString() };
      }

      case 'ui.find': {
        const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
        await adbShell(deviceId, `uiautomator dump ${remote}`);
        const xml = await adbShell(deviceId, `cat ${remote}`);
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

        // Parse matching nodes from the XML
        const nodeRegex = /<node([^>]+)>/g;
        const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
        const matches: any[] = [];
        let nodeMatch;

        while ((nodeMatch = nodeRegex.exec(xml)) !== null) {
          const attrStr = nodeMatch[1];
          const attrs: Record<string, string> = {};
          // fresh regex per node — avoid stateful lastIndex
          const attrRegexFresh = /(\w[\w-]*)="([^"]*)"/g;
          let attrMatch;
          while ((attrMatch = attrRegexFresh.exec(attrStr)) !== null) {
            attrs[attrMatch[1]] = attrMatch[2];
          }

          const matchesQuery =
            (!args.text || attrs['text'] === args.text) &&
            (!args.textContains || attrs['text']?.toLowerCase().includes(args.textContains.toLowerCase())) &&
            (!args.resourceId || attrs['resource-id'] === args.resourceId) &&
            (!args.className || attrs['class'] === args.className) &&
            (!args.contentDesc || attrs['content-desc'] === args.contentDesc);

          if (matchesQuery) {
            matches.push({
              text: attrs['text'],
              resourceId: attrs['resource-id'],
              className: attrs['class'],
              contentDesc: attrs['content-desc'],
              bounds: attrs['bounds'],
              clickable: attrs['clickable'] === 'true',
              scrollable: attrs['scrollable'] === 'true',
              enabled: attrs['enabled'] === 'true',
              focused: attrs['focused'] === 'true',
              checked: attrs['checked'] === 'true',
              selected: attrs['selected'] === 'true',
            });
          }
        }

        if (args.index !== undefined) {
          const el = matches[args.index];
          return { found: !!el, element: el ?? null, total: matches.length };
        }
        return { found: matches.length > 0, elements: matches, total: matches.length };
      }

      case 'ui.current_app':
      case 'app.current': {
        const raw = await adbShell(deviceId, 'dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp"');
        const pkg = raw.match(/([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\/[^}\s]+/)?.[1] ?? null;
        const activity = raw.match(/([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\/[^}\s]+)/)?.[1] ?? null;
        return { package: pkg, activity, raw: raw.trim() };
      }

      case 'ui.current_activity': {
        const raw = await adbShell(deviceId, 'dumpsys activity activities | grep -E "Resumed|mResumedActivity|TaskRecord" | head -10');
        return { info: raw.trim(), timestamp: new Date().toISOString() };
      }

      case 'ui.get_text': {
        const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
        await adbShell(deviceId, `uiautomator dump ${remote}`);
        const xml = await adbShell(deviceId, `cat ${remote}`);
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

        const nodeRegex = /<node([^>]+)>/g;
        const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
        let nodeMatch;
        const idx = args.index ?? 0;
        let count = 0;

        while ((nodeMatch = nodeRegex.exec(xml)) !== null) {
          const attrs: Record<string, string> = {};
          let m;
          while ((m = attrRegex.exec(nodeMatch[1])) !== null) attrs[m[1]] = m[2];

          const matches =
            (!args.resourceId || attrs['resource-id'] === args.resourceId) &&
            (!args.text || attrs['text'] === args.text) &&
            (!args.contentDesc || attrs['content-desc'] === args.contentDesc);

          if (matches) {
            if (count === idx) return { text: attrs['text'] ?? '', bounds: attrs['bounds'] };
            count++;
          }
        }
        return { text: null, error: 'Element not found' };
      }

      // ── UI Interaction ─────────────────────────────────────────────────────

      case 'ui.tap_element':
      case 'ui.long_press_element': {
        const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
        await adbShell(deviceId, `uiautomator dump ${remote}`).catch(() => {});
        const xml = await adbShell(deviceId, `cat ${remote}`).catch(() => '');
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

        const nodeRegex = /<node([^>]+)>/g;
        const idx = args.index ?? 0;
        let count = 0;
        let nodeMatch;

        while ((nodeMatch = nodeRegex.exec(xml)) !== null) {
          // IMPORTANT: create a fresh regex per node to avoid stateful lastIndex bug
          const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
          const attrs: Record<string, string> = {};
          let m;
          while ((m = attrRegex.exec(nodeMatch[1])) !== null) attrs[m[1]] = m[2];

          const matches =
            (!args.text || attrs['text'] === args.text) &&
            (!args.textContains || attrs['text']?.toLowerCase().includes(args.textContains.toLowerCase())) &&
            (!args.resourceId || attrs['resource-id'] === args.resourceId) &&
            (!args.className || attrs['class'] === args.className) &&
            (!args.contentDesc || attrs['content-desc'] === args.contentDesc);

          if (matches) {
            if (count === idx) {
              // Parse bounds [x1,y1][x2,y2]
              const b = attrs['bounds']?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
              if (!b) throw new Error(`Element found but bounds unparseable: ${attrs['bounds']}`);
              const cx = Math.floor((parseInt(b[1]) + parseInt(b[3])) / 2);
              const cy = Math.floor((parseInt(b[2]) + parseInt(b[4])) / 2);

              if (capabilityName === 'ui.long_press_element') {
                const dur = args.durationMs ?? 1000;
                await adbShell(deviceId, `input swipe ${cx} ${cy} ${cx} ${cy} ${dur}`);
                return { longPressed: true, x: cx, y: cy, bounds: attrs['bounds'], text: attrs['text'] };
              } else {
                await adbShell(deviceId, `input tap ${cx} ${cy}`);
                return { tapped: true, x: cx, y: cy, bounds: attrs['bounds'], text: attrs['text'] };
              }
            }
            count++;
          }
        }
        throw new Error(`Element not found matching query: ${JSON.stringify({ text: args.text, resourceId: args.resourceId, contentDesc: args.contentDesc, className: args.className })}`);
      }

      case 'input.long_press': {
        const dur = args.durationMs ?? 1000;
        await adbShell(deviceId, `input swipe ${args.x} ${args.y} ${args.x} ${args.y} ${dur}`);
        return { longPressed: true, x: args.x, y: args.y, durationMs: dur };
      }

      case 'input.double_tap': {
        const interval = args.intervalMs ?? 200;
        await adbShell(deviceId, `input tap ${args.x} ${args.y}`);
        await sleep(interval);
        await adbShell(deviceId, `input tap ${args.x} ${args.y}`);
        await sleep(100); // settle
        return { doubleTapped: true, x: args.x, y: args.y, intervalMs: interval };
      }

      case 'input.drag': {
        const dur = args.durationMs ?? 500;
        // Try draganddrop (API 26+), fall back to a slow swipe which works universally
        const result = await adbShell(deviceId, `input draganddrop ${args.x1} ${args.y1} ${args.x2} ${args.y2} ${dur}`)
          .catch(() => null);
        if (!result) {
          await adbShell(deviceId, `input swipe ${args.x1} ${args.y1} ${args.x2} ${args.y2} ${dur}`);
        }
        return { dragged: true, from: [args.x1, args.y1], to: [args.x2, args.y2], method: result ? 'draganddrop' : 'swipe' };
      }

      case 'input.pinch': {
        // Get screen size for percent calculation
        const sizeRaw = await adbShell(deviceId, 'wm size');
        const sizeMatch = sizeRaw.match(/(\d+)x(\d+)/);
        const screenW = sizeMatch ? parseInt(sizeMatch[1]) : 1080;
        const offset = Math.floor(screenW * (args.percent ?? 50) / 100 / 2);
        const cx = args.x, cy = args.y;
        const dur = args.durationMs ?? 500;
        const dir = args.direction ?? 'out';

        if (dir === 'out') {
          // Two fingers moving apart
          await execAsync(`adb -s ${deviceId} shell input swipe ${cx - offset} ${cy} ${cx - offset * 2} ${cy} ${dur} & adb -s ${deviceId} shell input swipe ${cx + offset} ${cy} ${cx + offset * 2} ${cy} ${dur}`).catch(() => {});
        } else {
          await execAsync(`adb -s ${deviceId} shell input swipe ${cx - offset * 2} ${cy} ${cx - offset} ${cy} ${dur} & adb -s ${deviceId} shell input swipe ${cx + offset * 2} ${cy} ${cx + offset} ${cy} ${dur}`).catch(() => {});
        }
        return { pinched: true, direction: dir, center: [cx, cy] };
      }

      // ── Text Editing ──────────────────────────────────────────────────────

      case 'ui.clear_text': {
        // Tap element first if identified
        if (args.resourceId || args.text) {
          const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
          await adbShell(deviceId, `uiautomator dump ${remote}`);
          const xml = await adbShell(deviceId, `cat ${remote}`);
          await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});
          const nodeRegex = /<node([^>]+)>/g;
          const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
          let nm;
          while ((nm = nodeRegex.exec(xml)) !== null) {
            const attrs: Record<string, string> = {};
            let m;
            while ((m = attrRegex.exec(nm[1])) !== null) attrs[m[1]] = m[2];
            if (
              (!args.resourceId || attrs['resource-id'] === args.resourceId) &&
              (!args.text || attrs['text'] === args.text)
            ) {
              const b = attrs['bounds']?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
              if (b) {
                const cx = Math.floor((parseInt(b[1]) + parseInt(b[3])) / 2);
                const cy = Math.floor((parseInt(b[2]) + parseInt(b[4])) / 2);
                await adbShell(deviceId, `input tap ${cx} ${cy}`);
                await sleep(200);
              }
              break;
            }
          }
        }
        // Move to end, then select all with SHIFT+MOVE_HOME, then delete
        await adbShell(deviceId, 'input keyevent KEYCODE_MOVE_END');
        await sleep(50);
        // Use CTRL+A via META key combo (works on most Android versions)
        await adbShell(deviceId, 'input keyevent --longpress KEYCODE_A');
        await sleep(100);
        await adbShell(deviceId, 'input keyevent 29 KEYCODE_A'); // CTRL+A
        await sleep(100);
        await adbShell(deviceId, 'input keyevent KEYCODE_DEL');
        await sleep(50);
        // Second pass: hold backspace to clear anything remaining
        await adbShell(deviceId, 'input keyevent --longpress KEYCODE_DEL');
        return { cleared: true };
      }

      case 'ui.clear_and_type': {
        // Focus field
        if (args.resourceId || args.fieldText) {
          const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
          await adbShell(deviceId, `uiautomator dump ${remote}`);
          const xml = await adbShell(deviceId, `cat ${remote}`);
          await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});
          const nodeRegex = /<node([^>]+)>/g;
          const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
          let nm;
          while ((nm = nodeRegex.exec(xml)) !== null) {
            const attrs: Record<string, string> = {};
            let m;
            while ((m = attrRegex.exec(nm[1])) !== null) attrs[m[1]] = m[2];
            if (
              (!args.resourceId || attrs['resource-id'] === args.resourceId) &&
              (!args.fieldText || attrs['text'] === args.fieldText)
            ) {
              const b = attrs['bounds']?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
              if (b) {
                const cx = Math.floor((parseInt(b[1]) + parseInt(b[3])) / 2);
                const cy = Math.floor((parseInt(b[2]) + parseInt(b[4])) / 2);
                if (args.tapFirst !== false) {
                  await adbShell(deviceId, `input tap ${cx} ${cy}`);
                  await sleep(200);
                }
              }
              break;
            }
          }
        }
        // Select all and delete (multi-strategy for Android compatibility)
        await adbShell(deviceId, 'input keyevent KEYCODE_MOVE_END');
        await sleep(50);
        await adbShell(deviceId, 'input keyevent 29 KEYCODE_A'); // CTRL+A
        await sleep(100);
        await adbShell(deviceId, 'input keyevent KEYCODE_DEL');
        await sleep(50);
        await adbShell(deviceId, 'input keyevent --longpress KEYCODE_DEL');
        await sleep(100);
        // Escape text safely for ADB input
        const escText = args.text
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\' ")
          .replace(/ /g, '%s')
          .replace(/"/g, '\\"');
        await adbShell(deviceId, `input text '${escText}'`);
        return { cleared: true, typed: args.text };
      }

      // ── Waiting ───────────────────────────────────────────────────────────

      case 'ui.wait_for_element': {
        const timeout = args.timeoutMs ?? 5000;
        const interval = args.intervalMs ?? 500;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
          const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
          await adbShell(deviceId, `uiautomator dump ${remote}`).catch(() => {});
          const xml = await adbShell(deviceId, `cat ${remote}`).catch(() => '');
          await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

          const nodeRegex = /<node([^>]+)>/g;
          let nm;
          while ((nm = nodeRegex.exec(xml)) !== null) {
            const attrs: Record<string, string> = {};
            const attrRx = /(\w[\w-]*)="([^"]*)"/g;
            let m;
            while ((m = attrRx.exec(nm[1])) !== null) attrs[m[1]] = m[2];
            const found =
              (!args.text || attrs['text'] === args.text) &&
              (!args.textContains || attrs['text']?.toLowerCase().includes(args.textContains.toLowerCase())) &&
              (!args.resourceId || attrs['resource-id'] === args.resourceId) &&
              (!args.className || attrs['class'] === args.className) &&
              (!args.contentDesc || attrs['content-desc'] === args.contentDesc);
            if (found) {
              return {
                found: true,
                element: { text: attrs['text'], resourceId: attrs['resource-id'], bounds: attrs['bounds'], className: attrs['class'] },
              };
            }
          }
          await sleep(interval);
        }
        return { found: false, timedOut: true, timeoutMs: timeout };
      }

      case 'ui.wait_for_gone': {
        const timeout = args.timeoutMs ?? 5000;
        const interval = args.intervalMs ?? 500;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
          const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
          await adbShell(deviceId, `uiautomator dump ${remote}`).catch(() => {});
          const xml = await adbShell(deviceId, `cat ${remote}`).catch(() => '');
          await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

          const nodeRegex = /<node([^>]+)>/g;
          const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
          let found = false;
          let nm;
          while ((nm = nodeRegex.exec(xml)) !== null) {
            const attrs: Record<string, string> = {};
            let m;
            while ((m = attrRegex.exec(nm[1])) !== null) attrs[m[1]] = m[2];
            if (
              (!args.text || attrs['text'] === args.text) &&
              (!args.textContains || attrs['text']?.toLowerCase().includes(args.textContains.toLowerCase())) &&
              (!args.resourceId || attrs['resource-id'] === args.resourceId) &&
              (!args.contentDesc || attrs['content-desc'] === args.contentDesc)
            ) { found = true; break; }
          }
          if (!found) return { gone: true };
          await sleep(interval);
        }
        return { gone: false, timedOut: true, timeoutMs: timeout };
      }

      case 'ui.wait_for_activity': {
        const timeout = args.timeoutMs ?? 5000;
        const interval = args.intervalMs ?? 500;
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline) {
          const raw = await adbShell(deviceId, 'dumpsys window windows | grep mCurrentFocus').catch(() => '');
          const matchesPkg = !args.package || raw.includes(args.package);
          const matchesAct = !args.activity || raw.includes(args.activity);
          if (matchesPkg && matchesAct) return { found: true, raw: raw.trim() };
          await sleep(interval);
        }
        return { found: false, timedOut: true, timeoutMs: timeout };
      }

      // ── Scrolling ─────────────────────────────────────────────────────────

      case 'ui.scroll': {
        const dir = args.direction ?? 'down';
        const times = args.times ?? 1;
        const dur = args.durationMs ?? 400;
        const sizeRaw = await adbShell(deviceId, 'wm size');
        const sizeMatch = sizeRaw.match(/(\d+)x(\d+)/);
        const w = sizeMatch ? parseInt(sizeMatch[1]) : 1080;
        const h = sizeMatch ? parseInt(sizeMatch[2]) : 1920;
        const cx = Math.floor(w / 2);
        const cy = Math.floor(h / 2);
        const swipeMap: Record<string, [number, number, number, number]> = {
          down:  [cx, Math.floor(h * 0.7), cx, Math.floor(h * 0.3)],
          up:    [cx, Math.floor(h * 0.3), cx, Math.floor(h * 0.7)],
          left:  [Math.floor(w * 0.8), cy, Math.floor(w * 0.2), cy],
          right: [Math.floor(w * 0.2), cy, Math.floor(w * 0.8), cy],
        };
        const [x1, y1, x2, y2] = swipeMap[dir];
        for (let i = 0; i < times; i++) {
          await adbShell(deviceId, `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`);
          if (i < times - 1) await sleep(300);
        }
        return { scrolled: true, direction: dir, times };
      }

      case 'ui.scroll_to': {
        const dir = args.direction ?? 'down';
        const maxSwipes = args.maxSwipes ?? 5;
        const dur = args.swipeDurationMs ?? 400;
        const sizeRaw = await adbShell(deviceId, 'wm size');
        const sizeMatch = sizeRaw.match(/(\d+)x(\d+)/);
        const w = sizeMatch ? parseInt(sizeMatch[1]) : 1080;
        const h = sizeMatch ? parseInt(sizeMatch[2]) : 1920;
        const cx = Math.floor(w / 2);
        const swipeMap: Record<string, [number, number, number, number]> = {
          down:  [cx, Math.floor(h * 0.7), cx, Math.floor(h * 0.3)],
          up:    [cx, Math.floor(h * 0.3), cx, Math.floor(h * 0.7)],
          left:  [Math.floor(w * 0.8), Math.floor(h / 2), Math.floor(w * 0.2), Math.floor(h / 2)],
          right: [Math.floor(w * 0.2), Math.floor(h / 2), Math.floor(w * 0.8), Math.floor(h / 2)],
        };
        const [x1, y1, x2, y2] = swipeMap[dir];

        for (let i = 0; i < maxSwipes; i++) {
          const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
          await adbShell(deviceId, `uiautomator dump ${remote}`).catch(() => {});
          const xml = await adbShell(deviceId, `cat ${remote}`).catch(() => '');
          await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

          const nodeRegex = /<node([^>]+)>/g;
          const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
          let nm;
          while ((nm = nodeRegex.exec(xml)) !== null) {
            const attrs: Record<string, string> = {};
            let m;
            while ((m = attrRegex.exec(nm[1])) !== null) attrs[m[1]] = m[2];
            const found =
              (!args.text || attrs['text'] === args.text) &&
              (!args.textContains || attrs['text']?.toLowerCase().includes(args.textContains.toLowerCase())) &&
              (!args.resourceId || attrs['resource-id'] === args.resourceId);
            if (found) return { found: true, swipes: i, element: { text: attrs['text'], bounds: attrs['bounds'] } };
          }
          await adbShell(deviceId, `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`);
          await sleep(400);
        }
        return { found: false, swipes: maxSwipes };
      }

      // ── Dialog Handling ───────────────────────────────────────────────────

      case 'ui.check_dialog': {
        const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
        await adbShell(deviceId, `uiautomator dump ${remote}`);
        const xml = await adbShell(deviceId, `cat ${remote}`);
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

        const hasDialog = xml.includes('android.app.AlertDialog') || xml.includes('android:id/alertTitle') || xml.includes('com.android.packageinstaller');
        const hasPermission = xml.includes('com.android.permissioncontroller') || xml.includes('permission_allow');
        const buttonTexts: string[] = [];
        const btnRegex = /<node[^>]*class="android\.widget\.Button"[^>]*text="([^"]+)"/g;
        let bm;
        while ((bm = btnRegex.exec(xml)) !== null) buttonTexts.push(bm[1]);

        return {
          dialogVisible: hasDialog || hasPermission || buttonTexts.length > 0,
          isPermissionDialog: hasPermission,
          isAlertDialog: hasDialog,
          buttons: buttonTexts,
          timestamp: new Date().toISOString(),
        };
      }

      case 'ui.dismiss_dialog': {
        const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
        await adbShell(deviceId, `uiautomator dump ${remote}`).catch(() => {});
        const xml = await adbShell(deviceId, `cat ${remote}`).catch(() => '');
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

        // Try preferred button first
        if (args.preferButton) {
          const nodeRegex = /<node([^>]+)>/g;
          const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
          let nm;
          while ((nm = nodeRegex.exec(xml)) !== null) {
            const attrs: Record<string, string> = {};
            let m;
            while ((m = attrRegex.exec(nm[1])) !== null) attrs[m[1]] = m[2];
            if (attrs['text']?.toLowerCase() === args.preferButton.toLowerCase() && attrs['clickable'] === 'true') {
              const b = attrs['bounds']?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
              if (b) {
                await adbShell(deviceId, `input tap ${Math.floor((+b[1] + +b[3]) / 2)} ${Math.floor((+b[2] + +b[4]) / 2)}`);
                return { dismissed: true, via: args.preferButton };
              }
            }
          }
        }

        // Try common dismiss labels
        const dismissLabels = ['Cancel', 'Dismiss', 'No thanks', 'Not now', 'Close', 'Skip', 'Later', 'No'];
        for (const label of dismissLabels) {
          const btn = xml.match(new RegExp(`<node[^>]*text="${label}"[^>]*bounds="(\[[^\]]+\]\[[^\]]+\])"`));
          if (btn) {
            const b = btn[1].match(/(\d+)/g);
            if (b && b.length >= 4) {
              await adbShell(deviceId, `input tap ${Math.floor((+b[0] + +b[2]) / 2)} ${Math.floor((+b[1] + +b[3]) / 2)}`);
              return { dismissed: true, via: label };
            }
          }
        }

        // Fallback: Back key
        await adbShell(deviceId, 'input keyevent KEYCODE_BACK');
        return { dismissed: true, via: 'KEYCODE_BACK' };
      }

      case 'ui.handle_permission_dialog': {
        const action = args.action ?? 'allow';
        const remote = `/sdcard/oahl_uidump_${ts()}.xml`;
        await adbShell(deviceId, `uiautomator dump ${remote}`).catch(() => {});
        const xml = await adbShell(deviceId, `cat ${remote}`).catch(() => '');
        await adbShell(deviceId, `rm -f ${remote}`).catch(() => {});

        const labelMap: Record<string, string[]> = {
          allow:        ['Allow', 'ALLOW', 'Grant', 'OK', 'While using the app'],
          allow_always: ['Always allow', 'Allow all the time', 'Always', 'ALWAYS ALLOW'],
          allow_once:   ['Only this time', 'Allow only once', 'Just once', 'ONLY THIS TIME'],
          deny:         ['Deny', 'DENY', "Don't allow", "Don't allow", 'No'],
        };

        const candidates = labelMap[action] ?? labelMap['allow'];
        for (const label of candidates) {
          const escaped = label.replace(/'/g, "\'");
          const btnRegex = new RegExp(`<node[^>]*text="${escaped}"[^>]*bounds="(\[[^\]]+\]\[[^\]]+\])"`);
          const btn = xml.match(btnRegex);
          if (btn) {
            const b = btn[1].match(/(\d+)/g);
            if (b && b.length >= 4) {
              await adbShell(deviceId, `input tap ${Math.floor((+b[0] + +b[2]) / 2)} ${Math.floor((+b[1] + +b[3]) / 2)}`);
              return { handled: true, action, via: label };
            }
          }
        }

        // Fallback for allow: tap anywhere in top-right (common pattern)
        if (action === 'allow' || action === 'allow_once') {
          await adbShell(deviceId, 'input keyevent KEYCODE_TAB');
          await sleep(100);
          await adbShell(deviceId, 'input keyevent KEYCODE_ENTER');
          return { handled: true, action, via: 'keyboard_fallback' };
        }

        await adbShell(deviceId, 'input keyevent KEYCODE_BACK');
        return { handled: true, action, via: 'KEYCODE_BACK' };
      }

      // ── App Extras ────────────────────────────────────────────────────────

      case 'app.clear_data': {
        await adbShell(deviceId, `pm clear --user 0 ${args.package}`);
        return { cleared: true, package: args.package };
      }

      case 'app.info': {
        const raw = await adbShell(deviceId, `dumpsys package ${args.package}`);
        const version = raw.match(/versionName=([^\s]+)/)?.[1];
        const versionCode = raw.match(/versionCode=(\d+)/)?.[1];
        const firstInstall = raw.match(/firstInstallTime=([^\n]+)/)?.[1]?.trim();
        const lastUpdate = raw.match(/lastUpdateTime=([^\n]+)/)?.[1]?.trim();
        const enabled = raw.match(/enabled=(\w+)/)?.[1];
        const dataDir = raw.match(/dataDir=([^\s]+)/)?.[1];
        return { package: args.package, version, versionCode, firstInstall, lastUpdate, enabled, dataDir };
      }

      case 'app.permissions.list': {
        const raw = await adbShell(deviceId, `dumpsys package ${args.package} | grep -E "permission|granted"`);
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        const permissions = lines
          .filter(l => l.includes('android.permission') || l.includes('granted='))
          .map(l => ({
            permission: l.match(/(android\.permission\.\S+)/)?.[1] ?? l,
            granted: l.includes('granted=true'),
          }))
          .filter(p => !args.grantedOnly || p.granted);
        return { package: args.package, permissions, count: permissions.length };
      }

      case 'app.permissions.grant': {
        await adbShell(deviceId, `pm grant --user 0 ${args.package} ${args.permission}`);
        return { granted: true, package: args.package, permission: args.permission };
      }

      case 'app.permissions.revoke': {
        await adbShell(deviceId, `pm revoke --user 0 ${args.package} ${args.permission}`);
        return { revoked: true, package: args.package, permission: args.permission };
      }

      case 'app.broadcast': {
        const extrasStr = args.extras
          ? Object.entries(args.extras).map(([k, v]) => `--es ${k} "${v}"`).join(' ')
          : '';
        const pkgFlag = args.package ? `-p ${args.package}` : '';
        await adbShell(deviceId, `am broadcast --user 0 -a ${args.action} ${pkgFlag} ${extrasStr}`);
        return { sent: true, action: args.action };
      }

      // ── System Extras ─────────────────────────────────────────────────────

      case 'system.clipboard.set': {
        // Use am broadcast with a ClipboardManager helper via content provider
        const escaped = args.text.replace(/"/g, '\\"').replace(/'/g, "\'");
        await adbShell(deviceId, `am broadcast --user 0 -a clipper.set -e text "${escaped}"`).catch(async () => {
          // Fallback: use input to paste via cmd
          await adbShell(deviceId, `cmd clipboard set "${escaped}"`).catch(() => {});
        });
        return { set: true, length: args.text.length };
      }

      case 'system.clipboard.get': {
        const raw = await adbShell(deviceId, 'cmd clipboard get').catch(() => '');
        return { text: raw.trim() };
      }

      case 'system.wake': {
        const state = await adbShell(deviceId, 'dumpsys power | grep -E "mWakefulness|Display Power"').catch(() => '');
        // Always send WAKEUP — it is a no-op if screen is already on
        await adbShell(deviceId, 'input keyevent KEYCODE_WAKEUP');
        await sleep(300);
        return { woken: true, previousState: state.trim() };
      }

      case 'system.lock': {
        await adbShell(deviceId, 'input keyevent KEYCODE_SLEEP');
        return { locked: true };
      }

      case 'system.rotate': {
        const orientMap: Record<string, string> = { portrait: '0', landscape: '1', auto: '2' };
        const val = orientMap[args.orientation ?? 'portrait'] ?? '0';
        await adbShell(deviceId, `settings put system accelerometer_rotation ${val === '2' ? '1' : '0'}`);
        if (val !== '2') {
          await adbShell(deviceId, `settings put system user_rotation ${val}`);
        }
        return { orientation: args.orientation ?? 'portrait' };
      }

      case 'system.volume': {
        const streamMap: Record<string, number> = { music: 3, ring: 2, notification: 5, alarm: 4, call: 0 };
        const streamId = streamMap[args.stream ?? 'music'] ?? 3;
        if (args.mute) {
          await adbShell(deviceId, `media volume --stream ${streamId} --set 0`).catch(async () => {
            await adbShell(deviceId, `input keyevent KEYCODE_VOLUME_MUTE`);
          });
        } else if (args.level !== undefined) {
          await adbShell(deviceId, `media volume --stream ${streamId} --set ${args.level}`).catch(async () => {
            await adbShell(deviceId, `cmd media_session volume --stream ${streamId} --set ${args.level}`);
          });
        }
        return { stream: args.stream ?? 'music', level: args.level, mute: args.mute ?? false };
      }

      case 'system.wifi': {
        await adbShell(deviceId, `svc wifi ${args.enabled ? 'enable' : 'disable'}`);
        return { wifi: args.enabled };
      }

      case 'system.airplane_mode': {
        const val = args.enabled ? '1' : '0';
        await adbShell(deviceId, `settings put global airplane_mode_on ${val}`);
        await adbShell(deviceId, `am broadcast --user 0 -a android.intent.action.AIRPLANE_MODE --ez state ${args.enabled}`);
        return { airplaneMode: args.enabled };
      }

      case 'system.setting.get': {
        const ns = args.namespace ?? 'system';
        const value = await adbShell(deviceId, `settings get ${ns} ${args.key}`);
        return { namespace: ns, key: args.key, value: value.trim() };
      }

      case 'system.setting.set': {
        const ns = args.namespace ?? 'system';
        await adbShell(deviceId, `settings put ${ns} ${args.key} ${args.value}`);
        return { namespace: ns, key: args.key, value: args.value };
      }

      case 'system.props': {
        if (args.key) {
          const val = await adbShell(deviceId, `getprop ${args.key}`);
          return { key: args.key, value: val.trim() };
        }
        const all = await adbShell(deviceId, 'getprop');
        const props: Record<string, string> = {};
        for (const line of all.split('\n')) {
          const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
          if (m) props[m[1]] = m[2];
        }
        return { props, count: Object.keys(props).length };
      }

      // ── File Extras ───────────────────────────────────────────────────────

      case 'file.list': {
        const p = args.path ?? '/sdcard/';
        const cmd = args.recursive ? `find ${p} -maxdepth 5` : `ls -la ${p}`;
        const raw = await adbShell(deviceId, cmd).catch(() => '');
        const entries = raw.split('\n').map(l => l.trim()).filter(Boolean);
        return { path: p, entries, count: entries.length };
      }

      case 'file.delete': {
        const flag = args.recursive ? '-rf' : '-f';
        await adbShell(deviceId, `rm ${flag} "${args.path}"`);
        return { deleted: true, path: args.path };
      }

      case 'file.exists': {
        const result = await adbShell(deviceId, `test -e "${args.path}" && echo yes || echo no`);
        return { exists: result.trim() === 'yes', path: args.path };
      }

      case 'file.read': {
        const maxBytes = args.maxBytes ?? 65536;
        const raw = await adbShell(deviceId, `head -c ${maxBytes} "${args.path}"`);
        return { content: raw, path: args.path, bytes: raw.length };
      }

      default:
        throw new Error(`Unknown capability: ${capabilityName}`);
    }
  }
}

export default AndroidAdapter;
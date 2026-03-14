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
        const escaped = args.text.replace(/ /g, '%s');
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

      case 'app.launch':
        if (args.activity) {
          await adbShell(deviceId, `am start --user 0 -n ${args.package}/${args.activity}`);
        } else {
          await adbShell(deviceId, `monkey --user 0 -p ${args.package} -c android.intent.category.LAUNCHER 1`);
        }
        return { launched: args.package };

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

      default:
        throw new Error(`Unknown capability: ${capabilityName}`);
    }
  }
}

export default AndroidAdapter;
// utils/bmpcc.js - 最终版（包含双心跳、初始化序列）
import BLEUtil from './ble-util.js'

function stringToArrayBuffer(str) {
  const buf = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) {
    view[i] = str.charCodeAt(i);
  }
  return buf;
}

function arrayBufferToString(buf) {
  const view = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < view.length; i++) {
    str += String.fromCharCode(view[i]);
  }
  return str;
}

class BMPCC {
  constructor() {
    this.bleUtil = null;
    this.cameraManufacturer = 'Blackmagic';
    this.cameraModel = 'Camera';
    this.firmwareVersion = null;
    this.params = {
      lens: {}, video: {}, audio: {}, media: {},
      output: {}, display: {}, tally: {}, reference: {},
      configuration: {}, color_correction: {}, ptz_control: {}, metadata: {}
    };
    this.status = [];
    this.protocol = null;
    this._protocolLoaded = false;
    this.deviceId = null;
    this.serviceId = null;
    this.characteristicIds = {};
    this.controlCharacteristicId = null;
    this.timecode = null;
    this.raw_status = 0;
    this._debugCallback = null;
    this._recordingHeartbeatTimer = null;
    this._deviceNameCharId = null;
    this._statusCharId = null;
    this._loadProtocol();
  }

  setDebugCallback(callback) { this._debugCallback = callback; }
  _debugLog(message, data) {
    console.log(`[BMPCC] ${message}`, data || '');
    if (this._debugCallback) this._debugCallback(message, data);
  }

  setDeviceNameCharId(charId) {
    this._deviceNameCharId = charId;
    this._debugLog('Device Name 特征值 ID 已设置', charId);
  }

  setStatusCharId(charId) {
    this._statusCharId = charId;
    this._debugLog('Status 特征值 ID 已设置', charId);
  }

  _loadProtocol() {
    wx.request({
      url: '/data/PROTOCOL.json',
      success: (res) => {
        this.protocol = res.data;
        this._protocolLoaded = true;
        this._initParams();
      },
      fail: () => { this._useBuiltinProtocol(); }
    });
  }

  _useBuiltinProtocol() {
    this.protocol = {
      groups: [
        { name: "Lens", normalized_name: "lens", id: 0, parameters: [
          { id: 0, normalized_parameter: "focus", type: "fixed16", index: [] },
          { id: 1, normalized_parameter: "instantaneous_autofocus", type: "void", index: [] },
          { id: 3, normalized_parameter: "aperture_normalised", type: "fixed16", index: [] },
          { id: 5, normalized_parameter: "instantaneous_auto_aperture", type: "void", index: [] },
          { id: 6, normalized_parameter: "optical_image_stabilisation", type: "boolean", index: [] }
        ] },
        { name: "Video", normalized_name: "video", id: 1, parameters: [
          { id: 9, normalized_parameter: "recording_format", type: "int16", index: ["file frame rate","sensor frame rate","frame width","frame height","flags"] },
          { id: 14, normalized_parameter: "iso", type: "int32", index: [] }
        ] },
        { name: "Audio", normalized_name: "audio", id: 2, parameters: [
          { id: 0, normalized_parameter: "mic_level", type: "fixed16", index: [] },
          { id: 1, normalized_parameter: "headphone_level", type: "fixed16", index: [] },
          { id: 4, normalized_parameter: "input_type", type: "int8", index: [] },
          { id: 6, normalized_parameter: "phantom_power", type: "boolean", index: [] }
        ] },
        { name: "Media", normalized_name: "media", id: 10, parameters: [
          { id: 0, normalized_parameter: "codec", type: "int8", index: ["basic codec","code variant"] },
          { id: 4, normalized_parameter: "record", type: "void", index: [] },
          { id: 3, normalized_parameter: "still_capture", type: "void", index: [] }
        ] }
      ]
    };
    this._initParams();
    this._protocolLoaded = true;
  }

  _initParams() {
    if (!this.protocol) return;
    this.protocol.groups.forEach(group => {
      if (!this.params[group.normalized_name]) this.params[group.normalized_name] = {};
      group.parameters.forEach(parameter => {
        if (parameter.index && parameter.index.length > 0) {
          this.params[group.normalized_name][parameter.normalized_parameter] = new Array(parameter.index.length).fill(null);
        } else {
          this.params[group.normalized_name][parameter.normalized_parameter] = null;
        }
      });
    });
  }

  async waitForProtocol() {
    let waitCount = 0;
    while (!this._protocolLoaded && waitCount < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitCount++;
    }
    return this._protocolLoaded;
  }

  make16(a,b) { return (a << 8) | b; }
  make32(a,b,c,d) { return (a << 24) | (b << 16) | (c << 8) | d; }
  *chunks(arr,n) { for (let i=0; i<arr.length; i+=n) yield arr.slice(i,i+n); }

  setBLEUtil(bleUtil) {
    this.bleUtil = bleUtil;
    this.deviceId = bleUtil.deviceId;
    this.serviceId = bleUtil.serviceId;
    this.characteristicIds = bleUtil.characteristicIds;
  }

  handleIncoming(value) {
    const a = new Uint8Array(value);
    if (a.length < 6 || a[0] !== 0xFF) return;
    const groupId = a[4], paramId = a[5];
    const group = this.protocol?.groups.find(g => g.id === groupId);
    if (!group) return;
    const parameter = group.parameters.find(p => p.id === paramId);
    if (!parameter) return;

    let decodedValue;
    switch(parameter.type) {
      case 'int8':
        decodedValue = (parameter.index && parameter.index.length > 0) ? Array.from(a.slice(8)) : a[6];
        break;
      case 'int16':
        if (parameter.index && parameter.index.length > 0) {
          decodedValue = [];
          for (let chunk of this.chunks(Array.from(a.slice(8)),2)) {
            if (chunk.length===2) decodedValue.push(this.make16(chunk[1],chunk[0]));
          }
        } else decodedValue = this.make16(a[9],a[8]);
        break;
      case 'int32': decodedValue = this.make32(a[11],a[10],a[9],a[8]); break;
      case 'fixed16': decodedValue = this.make16(a[9],a[8]) / 2048; break;
      case 'string': decodedValue = arrayBufferToString(value.slice(6)); break;
      case 'boolean': decodedValue = a[6] !== 0; break;
      default: decodedValue = Array.from(a.slice(6));
    }
    if (this.params[group.normalized_name]) {
      this.params[group.normalized_name][parameter.normalized_parameter] = decodedValue;
      this._debugLog(`参数更新: ${group.normalized_name}.${parameter.normalized_parameter}`, decodedValue);
    }
  }

  handleStatus(value) {
    const a = new Uint8Array(value);
    if (a.length === 0) return;
    this.raw_status = a[0];
    let state = [];
    if (this.raw_status & 0x01) state.push('On');
    if (this.raw_status & 0x02) state.push('Connected');
    if (this.raw_status & 0x04) state.push('Paired');
    if (this.raw_status & 0x08) state.push('Versions Verified');
    if (this.raw_status & 0x10) state.push('Initial Payload Received');
    if (this.raw_status & 0x20) state.push('Camera Ready');
    this.status = state;
    this._debugLog('状态更新', state);
  }

  handleTimecode(value) {
    const a = new Uint8Array(value);
    if (a.length >= 12) {
      this.timecode = `${a[11].toString(16).padStart(2,'0')}:${a[10].toString(16).padStart(2,'0')}:${a[9].toString(16).padStart(2,'0')}:${a[8].toString(16).padStart(2,'0')}`;
      this._debugLog('时间码', this.timecode);
    }
  }

  getParam(groupId, paramId) {
    const group = this.protocol?.groups.find(g => g.id === groupId);
    if (!group) return null;
    const parameter = group.parameters.find(p => p.id === paramId);
    if (!parameter) return null;
    return this.params[group.normalized_name]?.[parameter.normalized_parameter];
  }

  async setParam(groupId, paramId, value) {
    if (!this.bleUtil || !this.serviceId || !this.characteristicIds["5DD3465F-1AEE-4299-8493-D2ECA2F8E1BB"]) return;
    const group = this.protocol?.groups.find(g => g.id === groupId);
    if (!group) return;
    const parameter = group.parameters.find(p => p.id === paramId);
    if (!parameter) return;

    let bytes, type;
    switch(parameter.type) {
      case 'int8':
        bytes = (parameter.index && parameter.index.length > 0) ? value : [value];
        type = 1; break;
      case 'int16':
        if (parameter.index && parameter.index.length > 0) {
          bytes = [];
          value.forEach(element => { bytes.push(element & 0xFF, (element >> 8) & 0xFF); });
        } else bytes = [value & 0xFF, (value >> 8) & 0xFF];
        type = 2; break;
      case 'int32':
        bytes = [value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF];
        type = 3; break;
      case 'fixed16':
        value = value * 2048;
        bytes = [value & 0xFF, (value >> 8) & 0xFF];
        type = 128; break;
      case 'string':
        bytes = Array.from(stringToArrayBuffer(value));
        type = 5; break;
      case 'boolean':
        bytes = [value ? 1 : 0];
        type = 1; break;
      default: return;
    }
    const packet = [0xFF, bytes.length + 4, 0x00, 0x00, groupId, paramId, type, 0, ...bytes];
    await this.sendPacket(packet);
  }

  async sendPacket(packet, writeType = 'write') {
    if (!this.bleUtil || !this.serviceId) throw new Error('未连接');
    let charId = this.controlCharacteristicId || this.characteristicIds["5DD3465F-1AEE-4299-8493-D2ECA2F8E1BB"];
    if (!charId) throw new Error('未找到控制特征值');
    const buffer = new ArrayBuffer(packet.length);
    new Uint8Array(buffer).set(packet);
    this._debugLog('发送指令', { packet: packet.join(','), length: packet.length, writeType, charId });
    await this.bleUtil.writeCharacteristic(this.serviceId, charId, buffer, writeType);
  }

  async requestRecordStatus() {
    const statusPacket = [0xFF, 0x08, 0x00, 0x00, 0x0A, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00];
    await this.sendPacket(statusPacket);
    this._debugLog('已发送录制状态查询');
  }

  async sendInitializationSequence() {
    this._debugLog('发送初始化序列');
    if (this._deviceNameCharId) {
      await this.bleUtil.writeCharacteristic(this.serviceId, this._deviceNameCharId, new Uint8Array([0x00]).buffer, 'write');
      this._debugLog('初始化：向 Device Name 写入 0x00');
    }
    if (this._statusCharId) {
      await this.bleUtil.writeCharacteristic(this.serviceId, this._statusCharId, new Uint8Array([0x01]).buffer, 'write');
      this._debugLog('初始化：向 Status 特征写入 0x01');
    }
    await this.requestRecordStatus();
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  async startRecording() {
    this._debugLog('调用 startRecording');
    await this.sendInitializationSequence();
    await this.requestRecordStatus();
    await new Promise(resolve => setTimeout(resolve, 200));
  
    // ✅ 只发送开始录制命令
    const packet1 = [0xFF, 0x08, 0x00, 0x00, 0x0A, 0x01, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00];
    await this.sendPacket(packet1);
    this._debugLog('开始录制命令已发送');
  
    // ✅ 心跳间隔调整为 500ms（避免干扰）
    if (this._recordingHeartbeatTimer) clearInterval(this._recordingHeartbeatTimer);
    if (this._deviceNameCharId && this._statusCharId && this.bleUtil) {
      this._recordingHeartbeatTimer = setInterval(async () => {
        try {
          await this.bleUtil.writeCharacteristic(
            this.serviceId, this._deviceNameCharId,
            new Uint8Array([0x00]).buffer, 'write'
          );
          await this.bleUtil.writeCharacteristic(
            this.serviceId, this._statusCharId,
            new Uint8Array([0x01]).buffer, 'write'
          );
          this._debugLog('双心跳写入成功');
        } catch (err) {
          this._debugLog('双心跳写入失败', err.message);
        }
      }, 500); // 50 → 500ms
      this._debugLog('双心跳已启动（500ms间隔）');
    }
  }

  async stopRecording() {
    this._debugLog('调用 stopRecording');
    if (this._recordingHeartbeatTimer) {
      clearInterval(this._recordingHeartbeatTimer);
      this._recordingHeartbeatTimer = null;
    }
    await this.requestRecordStatus();
    await new Promise(resolve => setTimeout(resolve, 200));
    const stopPacket = [0xFF, 0x08, 0x00, 0x00, 0x0A, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    await this.sendPacket(stopPacket);
    this._debugLog('停止录制命令已发送');
  }

  async sendRecordCommand(isRecording) {
    if (!this.bleUtil || !this.serviceId) throw new Error('未连接');
    if (isRecording) await this.startRecording();
    else await this.stopRecording();
  }

  async captureStill() {
    if (!this.bleUtil || !this.serviceId) throw new Error('未连接');
    this._debugLog('执行拍照命令');
    const packet = [0xFF, 0x08, 0x00, 0x00, 0x0A, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];
    await this.sendPacket(packet, 'write');
    this._debugLog('拍照命令已发送');
  }

  disconnect() {
    if (this._recordingHeartbeatTimer) {
      clearInterval(this._recordingHeartbeatTimer);
      this._recordingHeartbeatTimer = null;
    }
    if (this.bleUtil) this.bleUtil.disconnect();
  }
}

export default BMPCC;
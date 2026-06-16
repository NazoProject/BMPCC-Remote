// pages/index/index.js
import BMPCC from '../../utils/bmpcc.js'

Page({
  data: {
    connected: false,
    cameraReady: false,
    cameraManufacturer: '',
    cameraModel: '',
    firmwareVersion: null,
    requiresFirmwareUpdate: false,
    currentTab: 0,
    batteryLevel: null,
    timecode: '',
    scanResult: '',
    scanning: false,
    deviceList: [],
    debugLogs: [],
    isRecording: false,
    recordingStartTime: 0,
    recordingTime: '00:00:00',
    lensFocus: undefined,
    lensFocusPercent: '0',
    lensAperture: undefined,
    apertureValue: '--',
    lensOIS: undefined,
    videoIso: '--',
    recordingFormatWidth: 3840,
    recordingFormatHeight: 2160,
    audioMicLevel: undefined,
    audioMicLevelPercent: '0',
    audioHeadphoneLevel: undefined,
    audioHeadphonePercent: '0',
    audioInputType: 0,
    audioPhantomPower: false,
    mediaCodecIndex: 0,
    proResIndex: 0,
    brawIndex: 0,
    tabs: [
      { name: '镜头', id: 'lens' },
      { name: '视频', id: 'video' },
      { name: '音频', id: 'audio' },
      { name: '媒体', id: 'media' }
    ],
    isoList: [100,125,160,200,250,320,400,500,640,800,1000,1250,1600,2000,2500,3200,4000,5000,6400,8000,10000,12800,16000,20000,25600],
    frameRateOptions: ['24','25','30','50','60'],
    offSpeedOptions: ['24','25','30','50','60','120'],
    inputTypeOptions: ['内置麦克风','线路输入','低电平麦克风','高电平麦克风'],
    codecOptions: ['CinemaDNG','DNxHD','ProRes','Blackmagic RAW'],
    proResOptions: ['HQ','422','LT','Proxy','444','444XQ'],
    brawOptions: ['Q0','Q1','Q3','Q5','3:1','5:1','8:1','12:1'],
    resolutions: [
      { name: '4K DCI', width: 4096, height: 2160 },
      { name: 'Ultra HD', width: 3840, height: 2160 },
      { name: 'HD', width: 1920, height: 1080 }
    ]
  },

  camera: null,
  pollingTimer: null,
  recordingTimer: null,
  selectedFrameRate: 0,
  selectedOffSpeed: 0,
  isoIndex: 0,
  scanTimeout: null,

  onLoad() { this.initBluetooth(); },
  onUnload() {
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    if (this.recordingTimer) clearInterval(this.recordingTimer);
    if (this.scanTimeout) clearTimeout(this.scanTimeout);
    if (this.camera) this.camera.disconnect();
  },

  addDebugLog(message, data) {
    const logEntry = { time: new Date().toLocaleTimeString(), message, data: data ? (typeof data === 'object' ? JSON.stringify(data) : String(data)) : '' };
    const newLogs = [logEntry, ...this.data.debugLogs].slice(0, 50);
    this.setData({ debugLogs: newLogs });
    console.log(`[DEBUG] ${message}`, data || '');
  },

  async initBluetooth() {
    try {
      wx.openBluetoothAdapter({ 
        success: () => { this.addDebugLog('蓝牙适配器初始化成功'); this.setData({ scanResult: '蓝牙已就绪' }); },
        fail: (err) => { this.addDebugLog('蓝牙适配器初始化失败', err); this.setData({ scanResult: '请开启手机蓝牙后重试' }); }
      });
    } catch (err) { this.addDebugLog('初始化蓝牙异常', err); }
  },

  stopScan() {
    if (this.scanTimeout) clearTimeout(this.scanTimeout);
    wx.stopBluetoothDevicesDiscovery({ success: () => this.addDebugLog('已停止扫描'), fail: () => {} });
    wx.offBluetoothDeviceFound();
    this.setData({ scanning: false });
  },

  refreshScan() { this.setData({ deviceList: [], scanResult: '', debugLogs: [] }); this.onScanOnly(); },

  async onScanOnly() {
    this.stopScan();
    this.setData({ scanning: true, deviceList: [], scanResult: '正在扫描蓝牙设备...', debugLogs: [] });
    this.addDebugLog('开始扫描蓝牙设备');
    try {
      await new Promise((resolve, reject) => {
        wx.closeBluetoothAdapter({ complete: () => {
          wx.openBluetoothAdapter({ success: resolve, fail: (err) => { this.addDebugLog('打开蓝牙适配器失败', err); reject(new Error('请开启手机蓝牙')); } });
        } });
      });
      const foundDevices = new Map();
      wx.onBluetoothDeviceFound((res) => {
        for (let device of res.devices) {
          const deviceName = device.name || device.localName || '未知设备';
          if (!foundDevices.has(device.deviceId)) {
            foundDevices.set(device.deviceId, { name: deviceName, deviceId: device.deviceId, RSSI: device.RSSI, localName: device.localName });
            const deviceList = Array.from(foundDevices.values()).sort((a,b) => (b.RSSI||-100)-(a.RSSI||-100));
            this.setData({ deviceList, scanResult: `已发现 ${deviceList.length} 个设备` });
            this.addDebugLog('发现设备', { name: deviceName, id: device.deviceId, rssi: device.RSSI });
          }
        }
      });
      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        success: () => {
          this.addDebugLog('开始扫描');
          this.setData({ scanResult: '扫描中，请稍候...' });
          this.scanTimeout = setTimeout(() => {
            this.stopScan();
            const count = this.data.deviceList.length;
            this.addDebugLog('扫描完成', { total: count });
            if (count === 0) { this.setData({ scanResult: '未发现任何蓝牙设备\n\n请确保:\n1. 手机蓝牙已开启\n2. 相机蓝牙已开启\n3. 相机靠近手机' }); }
            else {
              const cameraDevices = this.data.deviceList.filter(d => d.name && d.name.startsWith('A:'));
              if (cameraDevices.length === 0) this.setData({ scanResult: `共发现 ${count} 个设备，但未找到 BMPCC 相机\n\n请确保相机蓝牙已开启并处于可被发现状态` });
              else this.setData({ scanResult: `✅ 发现 ${cameraDevices.length} 个 BMPCC 相机，共 ${count} 个设备` });
            }
            this.setData({ scanning: false });
          }, 30000);
        },
        fail: (err) => { this.addDebugLog('开始扫描失败', err); this.stopScan(); this.setData({ scanResult: '蓝牙扫描失败: ' + (err.errMsg || '未知错误'), scanning: false }); }
      });
    } catch (err) { this.addDebugLog('扫描异常', err); this.stopScan(); this.setData({ scanResult: err.message || '扫描失败', scanning: false }); }
  },

  async selectDevice(e) {
    const device = e.currentTarget.dataset.device;
    this.addDebugLog('选择设备', { name: device.name, id: device.deviceId });
    wx.showModal({ title: '连接设备', content: `是否连接 ${device.name || '未命名设备'}？`, success: async (res) => { if (res.confirm) { this.stopScan(); await this.connectToDevice(device.deviceId); } } });
  },

  updateParamsUI() {
    if (!this.camera || !this.camera.params) return;
    const params = this.camera.params;
    const lensFocus = params.lens?.focus;
    const lensAperture = params.lens?.aperture_normalised;
    const lensOIS = params.lens?.optical_image_stabilisation;
    let apertureValue = '--';
    if (params.lens?.aperture_f_stop !== undefined) apertureValue = (Math.sqrt(Math.pow(2, params.lens.aperture_f_stop))).toFixed(1);
    const videoIso = params.video?.iso || '--';
    const recordingFormat = params.video?.recording_format;
    let recordingFormatWidth = 3840, recordingFormatHeight = 2160;
    if (recordingFormat && recordingFormat.length >= 4) { recordingFormatWidth = recordingFormat[2]; recordingFormatHeight = recordingFormat[3]; }
    let isoIndex = this.data.isoList.indexOf(videoIso); if (isoIndex < 0) isoIndex = 0;
    const audioMicLevel = params.audio?.mic_level;
    const audioHeadphoneLevel = params.audio?.headphone_level;
    const audioInputType = params.audio?.input_type || 0;
    const audioPhantomPower = params.audio?.phantom_power || false;
    const codec = params.media?.codec;
    let mediaCodecIndex = 0, proResIndex = 0, brawIndex = 0;
    if (codec && codec.length > 0) { mediaCodecIndex = codec[0] || 0; if (codec[1] !== undefined) { proResIndex = codec[1]; brawIndex = codec[1]; } }
    this.setData({
      lensFocus, lensFocusPercent: lensFocus !== undefined ? (lensFocus * 100).toFixed(0) : '0', lensAperture, apertureValue, lensOIS,
      videoIso, recordingFormatWidth, recordingFormatHeight, isoIndex,
      audioMicLevel, audioMicLevelPercent: audioMicLevel !== undefined ? (audioMicLevel * 100).toFixed(0) : '0',
      audioHeadphoneLevel, audioHeadphonePercent: audioHeadphoneLevel !== undefined ? (audioHeadphoneLevel * 100).toFixed(0) : '0',
      audioInputType, audioPhantomPower, mediaCodecIndex, proResIndex, brawIndex
    });
  },

  async checkFirmwareVersion() {
    this.addDebugLog('检测相机固件版本');
    try {
      const deviceInfoUuid = "0000180A-0000-1000-8000-00805F9B34FB";
      const firmwareCharUuid = "00002A26-0000-1000-8000-00805F9B34FB";
      const chars = await this.camera.bleUtil.getCharacteristics(deviceInfoUuid, [firmwareCharUuid]);
      if (chars[firmwareCharUuid]) {
        const value = await this.camera.bleUtil.readCharacteristic(deviceInfoUuid, chars[firmwareCharUuid]);
        const firmware = this.camera.bleUtil.arrayBufferToString(value);
        this.setData({ firmwareVersion: firmware });
        this.addDebugLog('固件版本', firmware);
        const versionMatch = firmware.match(/(\d+)\.(\d+)/);
        if (versionMatch) {
          const major = parseInt(versionMatch[1]), minor = parseInt(versionMatch[2]);
          if (major < 6 || (major === 6 && minor < 2)) { this.setData({ requiresFirmwareUpdate: true }); this.addDebugLog('提示: 需要固件版本 6.2 或更高'); }
        }
      } else { this.addDebugLog('无法读取固件版本'); }
    } catch (err) { this.addDebugLog('固件版本检测失败', err.message); }
  },

  async getCharacteristicDetails(serviceId, characteristicId) {
    return new Promise((resolve, reject) => {
      wx.getBLEDeviceCharacteristics({ deviceId: this.camera.bleUtil.deviceId, serviceId, success: (res) => { const char = res.characteristics.find(c => c.uuid === characteristicId); char ? resolve(char) : reject(new Error('未找到特征值')); }, fail: reject });
    });
  },

  async connectToDevice(deviceId) {
    wx.showLoading({ title: '连接中...', mask: true });
    this.addDebugLog('开始连接流程', { deviceId });
    try {
      const BLEUtil = require('../../utils/ble-util.js').default;
      const bleUtil = new BLEUtil();
      bleUtil.onDebugLog = (log) => { this.addDebugLog(`[BLE] ${log.message}`, log.data); };
      await bleUtil.init();
      await bleUtil.connectDevice(deviceId);
      this.addDebugLog('物理连接成功，开始发现服务和特征值...');

      const targetServiceUuid = "291D567A-6D75-11E6-8B77-86F30CA893D3";
      await bleUtil.getServices(targetServiceUuid);
      this.addDebugLog('获取服务成功', { serviceId: bleUtil.serviceId });

      const targetUuids = [
        "5DD3465F-1AEE-4299-8493-D2ECA2F8E1BB",
        "B864E140-76A0-416A-BF30-5876504537D9",
        "6D8F2110-86F1-41BF-9AFB-451D87E976C8",
        "7FE8691D-95DC-4FC5-8ABD-CA74339B51B9"
      ];
      const chars = await bleUtil.getCharacteristics(bleUtil.serviceId, targetUuids);
      this.addDebugLog('获取特征值成功', Object.keys(chars));

      let writeCharId = chars["5DD3465F-1AEE-4299-8493-D2ECA2F8E1BB"];
      for (const charId of Object.values(chars)) {
        if (charId === writeCharId) continue;
        try {
          const details = await bleUtil.getCharacteristicDetails(bleUtil.serviceId, charId);
          if (details.properties.write) {
            writeCharId = charId;
            this.addDebugLog('找到备用可写特征值', charId);
            break;
          }
        } catch (e) {}
      }

      this.camera = new BMPCC();
      await this.camera.waitForProtocol();
      this.camera.setDebugCallback((message, data) => { this.addDebugLog(`[相机] ${message}`, data); });
      this.camera.setBLEUtil(bleUtil);
      this.camera.characteristicIds = chars;
      this.camera.controlCharacteristicId = writeCharId;

      // 触发加密配对
      const statusCharId = chars["7FE8691D-95DC-4FC5-8ABD-CA74339B51B9"];
      if (statusCharId) {
        this.addDebugLog('触发加密配对：向 Status 特征写入 0x01');
        const triggerPacket = new Uint8Array([0x01]);
        await bleUtil.writeCharacteristic(bleUtil.serviceId, statusCharId, triggerPacket.buffer, 'write');
        this.addDebugLog('配对触发信号已发送，请查看手机系统弹出的配对请求并输入相机屏幕上的 PIN 码');
        
        let bondCheckCount = 0;
        while (bondCheckCount < 30) {
          try {
            await bleUtil.getServices(targetServiceUuid);
            this.addDebugLog('配对完成');
            break;
          } catch (err) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            bondCheckCount++;
          }
        }
      } else {
        this.addDebugLog('未找到 Status 特征值，无法触发加密配对');
      }

      // 保存 Device Name 和 Status 特征值ID
      try {
        const deviceNameUuid = "ffac0c52-c9fb-41a0-b063-cc76282eb89c";
        const nameChars = await bleUtil.getCharacteristics(bleUtil.serviceId, [deviceNameUuid]);
        if (nameChars[deviceNameUuid]) {
          this.camera.setDeviceNameCharId(nameChars[deviceNameUuid]);
          await bleUtil.writeCharacteristic(bleUtil.serviceId, nameChars[deviceNameUuid], new Uint8Array([0x00]).buffer, 'write');
          this.addDebugLog('已向 Device Name 写入 0x00，心跳特征已保存');
        } else {
          this.addDebugLog('未找到 Device Name 特征值');
        }
      } catch (err) {
        this.addDebugLog('写入 Device Name 失败', err.message);
      }

      if (statusCharId) {
        this.camera.setStatusCharId(statusCharId);
        this.addDebugLog('Status 特征值已保存，用于备用心跳');
      }

      // 设置通知
      for (const [uuid, charId] of Object.entries(chars)) {
        if (uuid !== "5DD3465F-1AEE-4299-8493-D2ECA2F8E1BB") {
          try {
            await bleUtil.notifyCharacteristic(bleUtil.serviceId, charId, true);
            this.addDebugLog(`通知设置成功: ${uuid}`);
          } catch (err) {
            this.addDebugLog(`通知设置失败: ${uuid}`, err.message);
          }
        }
      }

      // 发送初始参数请求
      try {
        const initPacket = [0xFF, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        await bleUtil.writeCharacteristic(bleUtil.serviceId, writeCharId, new Uint8Array(initPacket).buffer, 'write');
        this.addDebugLog('发送初始参数请求');
      } catch (err) { this.addDebugLog('初始参数请求失败', err.message); }

      // 读取设备信息
      let manufacturer = 'Blackmagic', model = 'Camera';
      try {
        const deviceInfoUuid = "0000180A-0000-1000-8000-00805F9B34FB";
        const infoChars = await bleUtil.getCharacteristics(deviceInfoUuid, ["00002A29-0000-1000-8000-00805F9B34FB","00002A24-0000-1000-8000-00805F9B34FB"]);
        if (infoChars["00002A29-0000-1000-8000-00805F9B34FB"]) {
          const value = await bleUtil.readCharacteristic(deviceInfoUuid, infoChars["00002A29-0000-1000-8000-00805F9B34FB"]);
          manufacturer = bleUtil.arrayBufferToString(value);
          this.addDebugLog('制造商', manufacturer);
        }
        if (infoChars["00002A24-0000-1000-8000-00805F9B34FB"]) {
          const value = await bleUtil.readCharacteristic(deviceInfoUuid, infoChars["00002A24-0000-1000-8000-00805F9B34FB"]);
          model = bleUtil.arrayBufferToString(value);
          this.addDebugLog('型号', model);
        }
      } catch (err) { this.addDebugLog('读取设备信息失败', err.message); }

      this.camera.cameraManufacturer = manufacturer;
      this.camera.cameraModel = model;

      bleUtil.onCharacteristicValueChange((result) => {
        if (result.deviceId !== deviceId) return;
        const charId = result.characteristicId.toUpperCase();
        if (chars["7FE8691D-95DC-4FC5-8ABD-CA74339B51B9"] && charId === chars["7FE8691D-95DC-4FC5-8ABD-CA74339B51B9"].toUpperCase()) {
          this.camera.handleStatus(result.value);
          const status = this.camera.status;
          this.addDebugLog('状态更新', status);
          if (status.includes('Camera Ready') && !this.data.cameraReady) {
            this.setData({ cameraReady: true });
            this.addDebugLog('✅ 相机已就绪');
          }
        } else if (chars["6D8F2110-86F1-41BF-9AFB-451D87E976C8"] && charId === chars["6D8F2110-86F1-41BF-9AFB-451D87E976C8"].toUpperCase()) {
          this.camera.handleTimecode(result.value); this.setData({ timecode: this.camera.timecode });
        } else if (chars["B864E140-76A0-416A-BF30-5876504537D9"] && charId === chars["B864E140-76A0-416A-BF30-5876504537D9"].toUpperCase()) {
          this.camera.handleIncoming(result.value); this.updateParamsUI();
        }
      });

      this.setData({ connected: true, cameraManufacturer: manufacturer, cameraModel: model, deviceList: [], scanResult: '' });
      await this.checkFirmwareVersion();
      wx.hideLoading(); wx.showToast({ title: '连接成功', icon: 'success' }); this.addDebugLog('🎉 连接完成！');
      this.startParamPolling();

      setTimeout(() => { if (!this.data.cameraReady && this.data.connected) { this.addDebugLog('强制设置相机就绪状态（超时）'); this.setData({ cameraReady: true }); } }, 10000);
    } catch (err) {
      wx.hideLoading(); this.addDebugLog('❌ 连接失败', err.message);
      wx.showModal({ title: '连接失败', content: err.message + '\n\n请查看调试日志了解详情', showCancel: false });
    }
  },

  async onConnectClick() {
    this.onScanOnly();
    let checkCount = 0;
    const checkInterval = setInterval(() => {
      checkCount++;
      const cameraDevices = this.data.deviceList.filter(d => d.name && d.name.startsWith('A:'));
      if (cameraDevices.length > 0 && !this.data.connected) { clearInterval(checkInterval); this.stopScan(); this.connectToDevice(cameraDevices[0].deviceId); }
      else if (checkCount > 30) { clearInterval(checkInterval); if (!this.data.connected) { this.stopScan(); this.addDebugLog('自动连接超时，未找到相机'); } }
    }, 1000);
  },

  startParamPolling() { if (this.pollingTimer) clearInterval(this.pollingTimer); this.pollingTimer = setInterval(() => this.updateParamsUI(), 500); },

  async toggleRecording() {
    if (!this.camera) { wx.showToast({ title: '相机未连接', icon: 'none' }); return; }
    if (this.data.requiresFirmwareUpdate) { wx.showModal({ title: '固件版本过低', content: `当前固件版本: ${this.data.firmwareVersion || '未知'}\n\nBMPCC 4K 需要固件 6.2 或更高版本才能支持蓝牙录制功能。`, showCancel: false }); return; }
    this.addDebugLog('toggleRecording 被调用', { isRecording: this.data.isRecording });
    try {
      if (this.data.isRecording) {
        this.addDebugLog('发送停止录制命令'); await this.camera.stopRecording(); this.addDebugLog('停止录制命令已发送');
        if (this.recordingTimer) clearInterval(this.recordingTimer);
        this.setData({ isRecording: false, recordingTime: '00:00:00' });
        wx.showToast({ title: '录制已停止', icon: 'success' }); wx.vibrateShort({ type: 'medium' });
      } else {
        this.addDebugLog('发送开始录制命令'); await this.camera.startRecording(); this.addDebugLog('开始录制命令已发送');
        const startTime = Date.now();
        this.setData({ isRecording: true, recordingStartTime: startTime });
        this.recordingTimer = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          const h = Math.floor(elapsed / 3600), m = Math.floor((elapsed % 3600) / 60), s = elapsed % 60;
          this.setData({ recordingTime: `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}` });
        }, 1000);
        wx.showToast({ title: '开始录制', icon: 'success' }); wx.vibrateShort({ type: 'medium' });
      }
    } catch (err) { this.addDebugLog('录制命令失败', err.message); wx.showModal({ title: '录制失败', content: `命令发送失败: ${err.message}\n\n请确保:\n1. 相机固件版本 ≥ 6.2\n2. 相机蓝牙已正确配对\n3. 相机处于可录制状态`, showCancel: false }); }
  },

  async captureStill() {
    if (!this.camera) { wx.showToast({ title: '相机未连接', icon: 'none' }); return; }
    this.addDebugLog('发送拍照命令');
    try { await this.camera.captureStill(); this.addDebugLog('拍照命令已发送'); wx.showToast({ title: '已拍摄', icon: 'success' }); wx.vibrateShort({ type: 'light' }); } catch (err) { this.addDebugLog('拍照失败', err.message); wx.showToast({ title: '拍照失败', icon: 'none' }); }
  },

  async testRecording() {
    if (!this.camera) { wx.showToast({ title: '相机未连接', icon: 'none' }); return; }
    this.addDebugLog('=== 开始测试录制命令 ===');
    await this.camera.sendPacket([0xFF,0x08,0x00,0x00,0x0A,0x01,0x01,0x00,0x02,0x00,0x00,0x00]);
    await new Promise(r => setTimeout(r, 2000));
    await this.camera.sendPacket([0xFF,0x08,0x00,0x00,0x0A,0x01,0x00,0x00,0x00,0x00,0x00,0x00]);
    this.addDebugLog('=== 测试完成 ===');
    wx.showToast({ title: '测试命令已发送', icon: 'success' });
  },

  switchTab(e) { this.setData({ currentTab: e.currentTarget.dataset.index }); },
  async updateSliderParameter(e) { const { group, id } = e.currentTarget.dataset; const value = parseFloat(e.detail.value); if (this.camera) await this.camera.setParam(parseInt(group), parseInt(id), value); },
  async updateCheckboxParameter(e) { const { group, id } = e.currentTarget.dataset; const value = e.detail.value.length > 0; if (this.camera) await this.camera.setParam(parseInt(group), parseInt(id), value); },
  async updatePickerParameter(e) { const { group, id, index } = e.currentTarget.dataset; const value = parseInt(e.detail.value); if (this.camera && index !== undefined) { const original = this.camera.getParam(parseInt(group), parseInt(id)); if (original && original[index] !== undefined) { original[index] = value; await this.camera.setParam(parseInt(group), parseInt(id), original); } } else if (this.camera) { await this.camera.setParam(parseInt(group), parseInt(id), value); } },
  async updateIsoParameter(e) { const { group, id, options } = e.currentTarget.dataset; const index = parseInt(e.detail.value); let isoList = options; if (typeof options === 'string') isoList = JSON.parse(options); const value = isoList[index]; if (this.camera) await this.camera.setParam(parseInt(group), parseInt(id), value); },
  async updateResolution(e) { const { width, height } = e.currentTarget.dataset; const original = this.camera.params.video?.recording_format || [24,24,3840,2160,0]; original[2]=width; original[3]=height; if (this.camera) await this.camera.setParam(1,9,original); },
  async autoFocus() { if (this.camera) { await this.camera.sendPacket([255,4,0,0,0,1,1,0,0,0,0,0]); wx.showToast({ title: '自动对焦中...', icon: 'none', duration: 1000 }); this.addDebugLog('执行自动对焦'); } },
  async autoAperture() { if (this.camera) { await this.camera.sendPacket([255,4,0,0,0,1,5,0,0,0,0,0]); wx.showToast({ title: '自动光圈中...', icon: 'none', duration: 1000 }); this.addDebugLog('执行自动光圈'); } }
});
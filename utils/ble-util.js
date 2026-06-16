// utils/ble-util.js - 完整版
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
  
  function abToHex(buf) {
    const view = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < view.length; i++) {
      hex += ('0' + view[i].toString(16)).slice(-2) + ' ';
    }
    return hex.trim();
  }
  
  class BLEUtil {
    constructor() {
      this.deviceId = null;
      this.serviceId = null;
      this.characteristicIds = {};
      this._isScanning = false;
      this._valueChangeHandlers = [];
      this._debugLog = [];
      this.onDebugLog = null;
    }
  
    log(message, data) {
      const logEntry = { time: new Date().toLocaleTimeString(), message, data };
      this._debugLog.push(logEntry);
      console.log(`[BLE] ${message}`, data || '');
      if (this.onDebugLog) this.onDebugLog(logEntry);
    }
  
    init() {
      return new Promise((resolve, reject) => {
        this.log('初始化蓝牙适配器');
        wx.closeBluetoothAdapter({ complete: () => {
          wx.openBluetoothAdapter({ success: () => { this.log('蓝牙适配器初始化成功'); resolve(); }, fail: (err) => { this.log('蓝牙适配器初始化失败', err); reject(new Error('请开启手机蓝牙')); } });
        } });
      });
    }
  
    connectDevice(deviceId, timeout = 10000) {
      return new Promise((resolve, reject) => {
        this.log('开始连接设备', { deviceId });
        wx.createBLEConnection({ deviceId, timeout, success: () => { this.log('BLE连接成功', { deviceId }); this.deviceId = deviceId; setTimeout(resolve, 500); }, fail: (err) => { this.log('BLE连接失败', err); reject(new Error('连接失败: ' + (err.errMsg || '未知错误'))); } });
      });
    }
  
    getServices(targetServiceUuid) {
      return new Promise((resolve, reject) => {
        if (!this.deviceId) reject(new Error('设备未连接'));
        this.log('获取设备服务', { deviceId: this.deviceId });
        wx.getBLEDeviceServices({ deviceId: this.deviceId, success: (res) => {
          this.log('获取到的服务列表', res.services.map(s => s.uuid));
          const targetService = res.services.find(s => s.uuid.toUpperCase() === targetServiceUuid.toUpperCase());
          if (targetService) { this.serviceId = targetService.uuid; this.log('找到目标服务', { serviceId: this.serviceId }); resolve(res.services); }
          else reject(new Error('未找到相机服务'));
        }, fail: (err) => { this.log('获取服务失败', err); reject(new Error('获取服务失败')); } });
      });
    }
  
    async getCharacteristicDetails(serviceId) {
      return new Promise((resolve, reject) => {
        if (!this.deviceId) reject(new Error('设备未连接'));
        wx.getBLEDeviceCharacteristics({ deviceId: this.deviceId, serviceId, success: (res) => resolve(res.characteristics), fail: reject });
      });
    }
  
    getCharacteristics(serviceId, targetUuids) {
      return new Promise((resolve, reject) => {
        if (!this.deviceId) reject(new Error('设备未连接'));
        this.log('获取特征值', { serviceId });
        wx.getBLEDeviceCharacteristics({ deviceId: this.deviceId, serviceId, success: (res) => {
          this.log('获取到的特征值列表', res.characteristics.map(c => ({ uuid: c.uuid, properties: c.properties })));
          const result = {};
          for (let targetUuid of targetUuids) {
            const char = res.characteristics.find(c => c.uuid.toUpperCase() === targetUuid.toUpperCase());
            if (char) { result[targetUuid] = char.uuid; this.log('找到特征值', { target: targetUuid, uuid: char.uuid }); }
            else this.log('未找到特征值', { targetUuid });
          }
          if (Object.keys(result).length === 0) reject(new Error('未找到任何特征值'));
          else { this.characteristicIds = { ...this.characteristicIds, ...result }; resolve(result); }
        }, fail: (err) => { this.log('获取特征值失败', err); reject(new Error('获取特征值失败')); } });
      });
    }
  
    readCharacteristic(serviceId, characteristicId) {
      return new Promise((resolve, reject) => {
        if (!this.deviceId) reject(new Error('设备未连接'));
        let timeoutId = setTimeout(() => { wx.offBLECharacteristicValueChange(handler); reject(new Error('读取超时')); }, 5000);
        const handler = (result) => {
          if (result.deviceId === this.deviceId && result.serviceId === serviceId && result.characteristicId === characteristicId) {
            clearTimeout(timeoutId); wx.offBLECharacteristicValueChange(handler); resolve(result.value);
          }
        };
        wx.onBLECharacteristicValueChange(handler);
        wx.readBLECharacteristicValue({ deviceId: this.deviceId, serviceId, characteristicId, fail: (err) => { clearTimeout(timeoutId); wx.offBLECharacteristicValueChange(handler); reject(err); } });
      });
    }
  
    notifyCharacteristic(serviceId, characteristicId, enable = true) {
      return new Promise((resolve, reject) => {
        if (!this.deviceId) reject(new Error('设备未连接'));
        wx.notifyBLECharacteristicValueChange({ deviceId: this.deviceId, serviceId, characteristicId, state: enable, success: () => { this.log('通知设置成功', { characteristicId, enable }); resolve(); }, fail: (err) => { this.log('通知设置失败', err); reject(err); } });
      });
    }
  
    writeCharacteristic(serviceId, characteristicId, data, writeType = 'write', maxRetries = 3) {
      return new Promise(async (resolve, reject) => {
        if (!this.deviceId) reject(new Error('设备未连接'));
        const hexData = abToHex(data);
        this.log('写入特征值', { serviceId, characteristicId, dataLength: data.byteLength, hex: hexData, writeType });
        let lastError = null;
        for (let i = 0; i < maxRetries; i++) {
          try {
            await new Promise((innerResolve, innerReject) => {
              wx.writeBLECharacteristicValue({ deviceId: this.deviceId, serviceId, characteristicId, value: data, success: () => { this.log(`写入成功 (尝试 ${i+1}/${maxRetries})`); innerResolve(); }, fail: (err) => { this.log(`写入失败 (尝试 ${i+1}/${maxRetries})`, err); innerReject(err); } });
            });
            resolve(); return;
          } catch (err) { lastError = err; if (i < maxRetries-1) await new Promise(resolve => setTimeout(resolve, 200)); }
        }
        reject(lastError);
      });
    }
  
    onCharacteristicValueChange(callback) {
      this._valueChangeHandlers.push(callback);
      wx.onBLECharacteristicValueChange((result) => {
        console.log(`[BLE] 收到通知: device=${result.deviceId}, char=${result.characteristicId}, data=${abToHex(result.value)}`);
        this._valueChangeHandlers.forEach(handler => { try { handler(result); } catch (err) { console.error(err); } });
      });
    }
  
    offCharacteristicValueChange(callback) {
      if (callback) { const index = this._valueChangeHandlers.indexOf(callback); if (index > -1) this._valueChangeHandlers.splice(index,1); }
      else { this._valueChangeHandlers = []; wx.offBLECharacteristicValueChange(); }
    }
  
    disconnect() {
      return new Promise((resolve) => {
        if (this.deviceId) { this.log('主动断开连接', { deviceId: this.deviceId }); wx.closeBLEConnection({ deviceId: this.deviceId, complete: () => { this.deviceId = null; this.serviceId = null; this.characteristicIds = {}; resolve(); } }); }
        else resolve();
        wx.closeBluetoothAdapter({ complete: () => {} });
        this.offCharacteristicValueChange();
        this._isScanning = false;
      });
    }
  
    stringToArrayBuffer(str) { return stringToArrayBuffer(str); }
    arrayBufferToString(buf) { return arrayBufferToString(buf); }
  }
  
  export default BLEUtil;
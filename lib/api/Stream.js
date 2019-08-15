'use strict';

const groupsApi = require('./http/endpoints/groups'),
  ApiDefinition = require('./http/ApiDefinition.js'),
  ApiError = require('../ApiError'),
  dtlsConnect = require('@nodertc/dtls').connect,
  rgbToXY = require('../rgb').rgbToXY;

// 16 byte header + 9 bytes for every light up to 10 lights
const BUFFER_SIZE = 106;
const DATA_OFFSET = 16;

class Stream {
  constructor(config) {
    const self = this;

    self._ipAddress = config.ipAddress;
    self._username = config.username;
    self._clientKey = config.clientKey;
    self._groupId = config.groupId;

    self._interval = null;
    self._socket = null;
    self._stateMap = new Map();

    self._buffer = Buffer.alloc(BUFFER_SIZE);
    let offset = 0;
    offset = self._buffer.write('HueStream', offset, 9, 'ascii');
    offset = self._buffer.writeUInt8(0x1, offset); // Major version
    offset += 4; // Minor version, Sequence ID, 2 reserved bytes
    offset = self._buffer.writeUInt8(0x1, offset); // XY colorspace

    self._lightMap = config.lightMap;
    self._XYConversion = new Map();
    for (const [id, light] of self._lightMap) {
      const gamut = light.capabilities.control.colorgamut;
      self._XYConversion.set(id, (r, g, b) =>
        rgbToXY([r, g, b], {
          red: {
            x: gamut[0][0],
            y: gamut[0][1],
          },
          green: {
            x: gamut[1][0],
            y: gamut[1][1],
          },
          blue: {
            x: gamut[2][0],
            y: gamut[2][1],
          },
        })
      );
    }
  }

  getLightMap() {
    return this._lightMap;
  }

  open() {
    const self = this;
    this._socket = dtlsConnect({
      type: 'udp4',
      remotePort: 2100,
      remoteAddress: this._ipAddress,
      pskIdentity: this._username,
      pskSecret: Buffer.from(this._clientKey, 'hex'),
      cipherSuites: ['TLS_PSK_WITH_AES_128_GCM_SHA256'],
    });

    this._socket.on(
      'connect',
      () => (self._interval = setInterval(self._sendMessage.bind(self), 20))
    );
    this._socket.on('error', console.log);

    return this;
  }

  close() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }

    this._stateMap.clear();
  }

  _sendMessage() {
    let offset = DATA_OFFSET;
    for (const [id, state] of this._stateMap) {
      offset += 1; // Type = 0x0 (light)
      offset = this._buffer.writeUInt16BE(id, offset);
      offset = this._buffer.writeUInt16BE(state.x * 0xffff, offset);
      offset = this._buffer.writeUInt16BE(state.y * 0xffff, offset);
      offset = this._buffer.writeUInt16BE(state.bri * 0xffff, offset);
    }
    this._socket.write(this._buffer.slice(0, offset));
  }

  setLightStateRGB(id, { r, g, b }, bri) {
    if (!this._XYConversion.has(id)) {
      throw new ApiError(`Light with id:${id} is not in group`);
    }
    const [x, y] = this._XYConversion.get(id)(r, g, b);
    this._stateMap.set(id, { x, y, bri });
  }

  setLightStateXY(id, { x, y }, bri) {
    if (!this._XYConversion.has(id)) {
      throw new ApiError(`Light with id:${id} is not in group`);
    }
    this._stateMap.set(id, { x, y, bri });
  }
}

module.exports = class StreamApi extends ApiDefinition {
  constructor(hueApi, request) {
    super(hueApi, request);
  }

  open(id, clientKey) {
    const self = this;
    const lightMap = new Map();
    return Promise.all([
      this.execute(groupsApi.getGroupAttributes, { id: id }),
      this.hueApi.getCachedState(),
    ])
      .then(([group, state]) => {
        if (!group || group.type !== 'Entertainment') {
          throw new ApiError(
            `Group with id:${id} not found or is not an Entertainment group`
          );
        }

        for (const light of group.lights) {
          lightMap.set(light, state.data.lights[light]);
        }

        return self.execute(groupsApi.setStreaming, { id, enable: true });
      })
      .then(result => {
        if (!result) {
          throw new ApiError(`Group with id:${id} could not enable streaming`);
        }

        return new Stream({
          ipAddress: self.hueApi._config.hostname,
          username: self.hueApi._config.username,
          clientKey,
          groupId: id,
          lightMap,
        }).open();
      });
  }
};

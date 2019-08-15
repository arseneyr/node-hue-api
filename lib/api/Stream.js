"use strict";

const groupsApi = require("./http/endpoints/groups"),
  ApiDefinition = require("./http/ApiDefinition.js"),
  ApiError = require("../ApiError"),
  dtlsConnect = require("@nodertc/dtls").connect;

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
    offset += self._buffer.write("HueStream", offset, 9, "ascii");
    offset += self._buffer.writeUInt8(0x1, offset); // Major version
  }

  open() {
    const self = this;
    this._socket = dtlsConnect({
      type: "udp4",
      remotePort: 2100,
      remoteAddress: this._ipAddress,
      pskIdentity: this._username,
      pskSecret: Buffer.from(this._clientKey, "hex"),
      cipherSuites: ["TLS_PSK_WITH_AES_128_GCM_SHA256"]
    });

    this._socket.on(
      "connect",
      () => (self._interval = setInterval(self._sendMessage.bind(self), 20))
    );
    this._socket.on("error", console.log);

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
    for (const [id, color] of this._stateMap) {
      offset += 1; // Type = 0x0 (light)
      offset = this._buffer.writeUInt16BE(id, offset);
      offset = this._buffer.writeUInt16BE(color.red, offset);
      offset = this._buffer.writeUInt16BE(color.green, offset);
      offset = this._buffer.writeUInt16BE(color.blue, offset);
    }
    this._socket.write(this._buffer.slice(0, offset));
  }

  setLightState(id, red, green, blue) {
    this._stateMap.set(id, { red, green, blue });
  }
}

module.exports = class StreamApi extends ApiDefinition {
  constructor(hueApi, request) {
    super(hueApi, request);
  }

  open(id, clientKey) {
    const self = this;
    return this.execute(groupsApi.getGroupAttributes, { id: id })
      .then(group => {
        if (!group || group.type !== "Entertainment") {
          throw new ApiError(
            `Group with id:${id} not found or is not an Entertainment group`
          );
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
          groupId: id
        }).open();
      });
  }
};

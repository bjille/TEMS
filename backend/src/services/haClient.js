const WebSocket = require('ws');
const axios = require('axios');
const { EventEmitter } = require('events');

function toWsUrl(httpUrl) {
  return httpUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/websocket';
}

/**
 * Wraps a single Home Assistant instance: a persistent authenticated
 * WebSocket connection subscribed to state_changed events, plus REST helpers
 * for initial state fetch and service calls (control commands).
 *
 * Emits: 'state_changed' ({ entityId, newState }), 'authenticated', 'error', 'close'
 */
class HaClient extends EventEmitter {
  constructor({ baseUrl, token }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.ws = null;
    this.msgId = 1;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.stopped = false;
  }

  connect() {
    this.stopped = false;
    this.ws = new WebSocket(toWsUrl(this.baseUrl));

    this.ws.on('open', () => {
      this.reconnectDelay = 1000;
    });

    this.ws.on('message', (raw) => this._handleMessage(raw));

    this.ws.on('close', () => {
      this.emit('close');
      if (!this.stopped) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _scheduleReconnect() {
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  _send(message) {
    const id = this.msgId++;
    this.ws.send(JSON.stringify({ ...message, id }));
    return id;
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'auth_required':
        this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        break;
      case 'auth_ok':
        this._send({ type: 'subscribe_events', event_type: 'state_changed' });
        this.emit('authenticated');
        break;
      case 'auth_invalid':
        this.emit('error', new Error(`HA auth failed: ${msg.message}`));
        this.close();
        break;
      case 'event':
        if (msg.event?.event_type === 'state_changed') {
          const { entity_id: entityId, new_state: newState } = msg.event.data;
          this.emit('state_changed', { entityId, newState });
        }
        break;
      default:
        break;
    }
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }

  async fetchState(entityId) {
    const res = await axios.get(`${this.baseUrl}/api/states/${entityId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.data;
  }

  async fetchAllStates() {
    const res = await axios.get(`${this.baseUrl}/api/states`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.data;
  }

  /**
   * Fetches state-change history for a single entity from HA's REST history
   * API (`/api/history/period/<start>`), used to drive chart drill-downs
   * without persisting readings ourselves.
   */
  async fetchHistory(entityId, { start, end } = {}) {
    const path = start
      ? `/api/history/period/${encodeURIComponent(start)}`
      : '/api/history/period';
    const params = { filter_entity_id: entityId, minimal_response: true };
    if (end) params.end_time = end;

    const res = await axios.get(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      params,
    });
    return res.data?.[0] || [];
  }

  async callService(domain, service, serviceData) {
    const res = await axios.post(
      `${this.baseUrl}/api/services/${domain}/${service}`,
      serviceData || {},
      { headers: { Authorization: `Bearer ${this.token}` } }
    );
    return res.data;
  }
}

module.exports = { HaClient };

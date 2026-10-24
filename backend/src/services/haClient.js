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
  // `minimalResponse: false` keeps full attributes on every returned state
  // instead of just the first — needed to read a dynamic-prices entity's
  // `prices_today`/`prices_tomorrow` attributes as they stood on past days
  // (see smartChargeEngine.js's history backfill), since HA's long-term
  // statistics track only the numeric state, never attributes.
  async fetchHistory(entityId, { start, end, minimalResponse = true } = {}) {
    const path = start
      ? `/api/history/period/${encodeURIComponent(start)}`
      : '/api/history/period';
    const params = { filter_entity_id: entityId, minimal_response: minimalResponse };
    if (end) params.end_time = end;

    const res = await axios.get(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      params,
    });
    return res.data?.[0] || [];
  }

  /**
   * HA's long-term statistics (`recorder/statistics_during_period`): hourly
   * aggregates the recorder keeps indefinitely for every sensor with a
   * state_class, unlike the state history behind fetchHistory, which is
   * purged after ~10 days. Resolves to { [statisticId]: rows[] }.
   */
  fetchStatistics(statisticIds, { start, end, period = 'hour', types = ['sum', 'mean'] }) {
    return this.wsRequest(
      {
        type: 'recorder/statistics_during_period',
        start_time: start,
        end_time: end,
        statistic_ids: statisticIds,
        period,
        types,
      },
      'Statistieken ophalen mislukt'
    ).then((result) => result || {});
  }

  /** Every entity's registry entry (entity_id, device_id, ...). */
  fetchEntityRegistry() {
    return this.wsRequest({ type: 'config/entity_registry/list' }, 'Entiteiten ophalen mislukt').then(
      (result) => result || []
    );
  }

  /**
   * One-off WebSocket command over a short-lived connection (separate from
   * the persistent state_changed subscription), resolving to its result.
   */
  wsRequest(command, failureMessage) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(toWsUrl(this.baseUrl));
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timeout bij ${command.type} in Home Assistant`));
      }, 30000);
      const finish = (fn, value) => {
        clearTimeout(timer);
        ws.close();
        fn(value);
      };
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        } else if (msg.type === 'auth_ok') {
          ws.send(JSON.stringify({ id: 1, ...command }));
        } else if (msg.type === 'auth_invalid') {
          finish(reject, new Error(`HA auth failed: ${msg.message}`));
        } else if (msg.id === 1) {
          if (msg.success) finish(resolve, msg.result);
          else finish(reject, new Error(msg.error?.message || failureMessage));
        }
      });
      ws.on('error', (err) => finish(reject, err));
    });
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

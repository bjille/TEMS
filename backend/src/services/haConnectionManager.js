const Woning = require('../models/Woning');
const Parameter = require('../models/Parameter');
const { HaClient } = require('./haClient');
const { decrypt } = require('../utils/crypto');
const { handleStateChange, markWoningStatus } = require('./ingestService');

// How often we force Home Assistant to re-poll entities flagged `realtime`
// on their Parameter (e.g. current power draw), instead of waiting for
// HA's own, often much slower, per-integration scan_interval to push an
// update. This calls HA's `homeassistant.update_entity` service, which
// triggers an immediate poll of that entity's source; the resulting
// state_changed event (if the value changed) flows through the normal
// websocket subscription below.
const REALTIME_POLL_MS = 1000;

/**
 * Keeps one HaClient per active woning alive, maps incoming state_changed
 * events to configured Parameters, and feeds them into ingestService.
 */
class HaConnectionManager {
  constructor() {
    /** @type {Map<string, { client: HaClient, parametersByEntity: Map<string, any> }>} */
    this.connections = new Map();
  }

  async startAll(io) {
    const woningen = await Woning.find({ status: { $ne: 'paused' } });
    await Promise.all(woningen.map((w) => this.start(w._id.toString(), io)));
  }

  async start(woningId, io) {
    woningId = woningId.toString();
    if (this.connections.has(woningId)) return;

    const woning = await Woning.findById(woningId).select('+haTokenEncrypted');
    if (!woning) return;

    const parametersByEntity = await this._loadParameterMap(woningId);

    let token;
    try {
      token = decrypt(woning.haTokenEncrypted);
    } catch (err) {
      console.error(`Failed to decrypt HA token for woning ${woningId}`, err);
      return;
    }

    const client = new HaClient({ baseUrl: woning.haBaseUrl, token });
    const realtimeTimer = setInterval(() => this._pollRealtime(woningId), REALTIME_POLL_MS);
    this.connections.set(woningId, { client, parametersByEntity, realtimeTimer });

    client.on('authenticated', () => {
      markWoningStatus(woningId, 'active').catch(console.error);
      this._syncInitialStates(woningId, io).catch((err) =>
        console.error(`Failed initial state sync for woning ${woningId}:`, err.message)
      );
    });
    client.on('error', (err) => {
      console.error(`HA client error for woning ${woningId}:`, err.message);
      markWoningStatus(woningId, 'error', err.message).catch(console.error);
    });

    client.on('state_changed', ({ entityId, newState }) => {
      const entry = this.connections.get(woningId);
      const parameter = entry?.parametersByEntity.get(entityId);
      if (!parameter) return;
      handleStateChange({ woningId, parameter, newState, io }).catch((err) =>
        console.error(`Failed to ingest reading for ${entityId}:`, err)
      );
    });

    client.connect();
  }

  /**
   * Right after connecting, the client has only subscribed to *future*
   * state_changed events — it doesn't know the current state of anything
   * yet. Without this, a parameter's "latest" reading stays whatever was
   * last persisted (possibly from a previous session, hours or days old)
   * until HA happens to report a fresh change for that entity. Pull the
   * current state for every configured entity once so the dashboard
   * reflects reality immediately.
   */
  async _syncInitialStates(woningId, io) {
    const entry = this.connections.get(woningId);
    if (!entry) return;

    const states = await entry.client.fetchAllStates();
    await Promise.all(
      states
        .filter((s) => entry.parametersByEntity.has(s.entity_id))
        .map((s) =>
          handleStateChange({
            woningId,
            parameter: entry.parametersByEntity.get(s.entity_id),
            newState: s,
            io,
          })
        )
    );
  }

  /** Forces HA to re-poll every entity flagged `realtime` for this woning. */
  async _pollRealtime(woningId) {
    const entry = this.connections.get(woningId);
    if (!entry) return;

    const entityIds = [...entry.parametersByEntity.values()]
      .filter((p) => p.realtime)
      .map((p) => p.entityId);
    if (entityIds.length === 0) return;

    try {
      await entry.client.callService('homeassistant', 'update_entity', {
        entity_id: entityIds,
      });
    } catch (err) {
      console.error(`Realtime poll failed for woning ${woningId}:`, err.message);
    }
  }

  async _loadParameterMap(woningId) {
    const parameters = await Parameter.find({ woning: woningId });
    return new Map(parameters.map((p) => [p.entityId, p]));
  }

  /** Refresh the entity->parameter map after parameters are added/removed. */
  async resubscribe(woningId) {
    woningId = woningId.toString();
    const entry = this.connections.get(woningId);
    if (!entry) return;
    entry.parametersByEntity = await this._loadParameterMap(woningId);
  }

  async restart(woningId, io) {
    this.stop(woningId);
    await this.start(woningId, io);
  }

  stop(woningId) {
    woningId = woningId.toString();
    const entry = this.connections.get(woningId);
    if (!entry) return;
    clearInterval(entry.realtimeTimer);
    entry.client.close();
    this.connections.delete(woningId);
  }

  stopAll() {
    for (const woningId of this.connections.keys()) this.stop(woningId);
  }

  getClient(woningId) {
    return this.connections.get(woningId.toString())?.client;
  }
}

const haConnectionManager = new HaConnectionManager();

module.exports = { haConnectionManager, HaConnectionManager };

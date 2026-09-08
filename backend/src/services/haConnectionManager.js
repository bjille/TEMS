const Woning = require('../models/Woning');
const Parameter = require('../models/Parameter');
const { HaClient } = require('./haClient');
const { decrypt } = require('../utils/crypto');
const { handleStateChange, markWoningStatus } = require('./ingestService');

/**
 * Keeps one HaClient per active woning alive, maps incoming state_changed
 * events to configured Parameters, and feeds them into ingestService.
 */
class HaConnectionManager {
  constructor() {
    /** @type {Map<string, { client: HaClient, parametersByEntity: Map<string, any[]> }>} */
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
    this.connections.set(woningId, { client, parametersByEntity });

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
      const parameters = entry?.parametersByEntity.get(entityId);
      if (!parameters) return;
      for (const parameter of parameters) {
        handleStateChange({ woningId, parameter, newState, io }).catch((err) =>
          console.error(`Failed to ingest reading for ${entityId}:`, err)
        );
      }
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
        .flatMap((s) =>
          entry.parametersByEntity.get(s.entity_id).map((parameter) =>
            handleStateChange({ woningId, parameter, newState: s, io })
          )
        )
    );
  }

  // A single HA entity can be mapped to more than one Parameter (e.g. once
  // plain and once with `invert` set), so each entityId maps to an array.
  async _loadParameterMap(woningId) {
    const parameters = await Parameter.find({ woning: woningId });
    const byEntity = new Map();
    for (const p of parameters) {
      if (!byEntity.has(p.entityId)) byEntity.set(p.entityId, []);
      byEntity.get(p.entityId).push(p);
    }
    return byEntity;
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

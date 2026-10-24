const Reading = require('../models/Reading');
const Woning = require('../models/Woning');
const { automationEngine } = require('./automationEngine');

const MINUTE_MS = 60 * 1000;

// Consumer power plugs report every few seconds; for these only the last
// state change of each minute is kept (see persistReading).
const PER_MINUTE_TYPES = ['energy_consumption'];

// parameterId -> { minute, reading: Promise<Reading> } — the Reading this
// minute's state changes overwrite.
const minuteReadings = new Map();

// Stores a state change as a Reading. A parameter with a long-term energy
// sensor (energyEntityId) keeps only its latest Reading, overwritten in
// place: its history comes from that sensor's HA statistics. For a
// PER_MINUTE_TYPES parameter, a later change within the same minute
// overwrites that minute's Reading (value and timestamp) instead of adding
// one. Either way the latest Reading stays the current state — automations
// and the dashboard read it.
async function persistReading(doc, parameter) {
  if (parameter.energyEntityId) {
    return Reading.findOneAndUpdate({ parameter: parameter._id }, doc, {
      sort: { timestamp: -1 },
      upsert: true,
      new: true,
    });
  }
  if (!PER_MINUTE_TYPES.includes(parameter.type)) return Reading.create(doc);
  const id = parameter._id.toString();
  const minute = Math.floor(doc.timestamp.getTime() / MINUTE_MS);
  const current = minuteReadings.get(id);
  if (current && current.minute === minute) {
    const reading = await current.reading;
    if (reading && doc.timestamp >= reading.timestamp) {
      reading.value = doc.value;
      reading.timestamp = doc.timestamp;
      await Reading.updateOne({ _id: reading._id }, { value: doc.value, timestamp: doc.timestamp });
      return reading;
    }
    if (reading) return reading; // an out-of-order older change
  }
  const created = Reading.create(doc);
  minuteReadings.set(id, { minute, reading: created.catch(() => null) });
  return created;
}

/**
 * Persists an incoming Home Assistant state change as a Reading and
 * broadcasts it to any frontend clients subscribed to the woning's room.
 */
async function handleStateChange({ woningId, parameter, newState, io }) {
  if (!newState) return;

  let value = coerceValue(newState.state);
  if (parameter.invert && typeof value === 'number') value = -value;
  const timestamp = newState.last_changed ? new Date(newState.last_changed) : new Date();

  const reading = await persistReading(
    { woning: woningId, parameter: parameter._id, value, unit: parameter.unit, timestamp },
    parameter
  );

  io?.to(`woning:${woningId}`).emit('reading', {
    parameterId: parameter._id.toString(),
    value: reading.value,
    unit: reading.unit,
    timestamp: reading.timestamp,
  });

  await automationEngine.onReading(woningId, parameter._id);
}

function coerceValue(rawState) {
  if (rawState === 'unavailable' || rawState === 'unknown') return null;
  const num = Number(rawState);
  return Number.isNaN(num) ? rawState : num;
}

async function markWoningStatus(woningId, status, errorMessage) {
  await Woning.findByIdAndUpdate(woningId, {
    status,
    lastError: errorMessage,
    ...(status === 'active' ? { lastConnectedAt: new Date() } : {}),
  });
}

module.exports = { handleStateChange, coerceValue, markWoningStatus };

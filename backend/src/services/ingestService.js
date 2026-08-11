const Reading = require('../models/Reading');
const Woning = require('../models/Woning');
const { automationEngine } = require('./automationEngine');
const { globalAutomationEngine } = require('./globalAutomationEngine');

/**
 * Persists an incoming Home Assistant state change as a Reading and
 * broadcasts it to any frontend clients subscribed to the woning's room.
 */
async function handleStateChange({ woningId, parameter, newState, io }) {
  if (!newState) return;

  const value = coerceValue(newState.state);
  const timestamp = newState.last_changed ? new Date(newState.last_changed) : new Date();

  const reading = await Reading.create({
    woning: woningId,
    parameter: parameter._id,
    value,
    unit: parameter.unit,
    timestamp,
  });

  io?.to(`woning:${woningId}`).emit('reading', {
    parameterId: parameter._id.toString(),
    value: reading.value,
    unit: reading.unit,
    timestamp: reading.timestamp,
  });

  await automationEngine.onReading(woningId, parameter._id);
  await globalAutomationEngine.onReading(woningId, parameter);
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

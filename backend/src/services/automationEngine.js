const cron = require('node-cron');
const Automation = require('../models/Automation');
const Reading = require('../models/Reading');
const CommandLog = require('../models/CommandLog');

const OPERATORS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

/**
 * Evaluates "if condition(s) then action" automations, mirroring Home
 * Assistant's automation model. Two trigger sources feed the same
 * evaluate-and-run path: a live reading (state trigger) or a cron tick
 * (schedule trigger).
 */
class AutomationEngine {
  constructor() {
    /** @type {Map<string, any[]>} woningId -> enabled Automation docs (action.parameter populated) */
    this.byWoning = new Map();
    /** @type {Map<string, { task: any, woningId: string }>} automationId -> cron task */
    this.cronTasks = new Map();
    /** @type {Map<string, { handle: any, woningId: string }>} automationId -> armed countdown timeout */
    this.timerTimeouts = new Map();
  }

  async loadAll() {
    const woningIds = await Automation.distinct('woning');
    await Promise.all(woningIds.map((id) => this.refreshWoning(id)));
  }

  async refreshWoning(woningId) {
    woningId = woningId.toString();

    for (const [automationId, entry] of this.cronTasks) {
      if (entry.woningId === woningId) {
        entry.task.stop();
        this.cronTasks.delete(automationId);
      }
    }
    for (const [automationId, entry] of this.timerTimeouts) {
      if (entry.woningId === woningId) {
        clearTimeout(entry.handle);
        this.timerTimeouts.delete(automationId);
      }
    }

    const automations = await Automation.find({ woning: woningId, enabled: true }).populate(
      'action.parameter'
    );
    this.byWoning.set(woningId, automations);

    for (const automation of automations) {
      if (automation.trigger.type === 'schedule' && automation.trigger.cronExpression) {
        this._registerCron(automation, automation.trigger.cronExpression);
      } else if (automation.trigger.type === 'timer') {
        if (automation.trigger.timerMode === 'clock' && automation.trigger.timerClockTime) {
          const cronExpression = this._clockTimeToCron(automation.trigger.timerClockTime);
          if (cronExpression) this._registerCron(automation, cronExpression);
        } else if (
          automation.trigger.timerMode === 'countdown' &&
          automation.trigger.timerArmed &&
          automation.trigger.timerTargetAt
        ) {
          this._armCountdown(automation);
        }
      }
    }
  }

  // Converts a dashboard-set "HH:MM" into a daily 5-field cron expression.
  _clockTimeToCron(timerClockTime) {
    const match = /^([01]?\d|2[0-3]):([0-5]?\d)$/.exec(timerClockTime);
    if (!match) return null;
    const [, hour, minute] = match;
    return `${Number(minute)} ${Number(hour)} * * *`;
  }

  _registerCron(automation, expression) {
    if (!cron.validate(expression)) {
      console.error(`Invalid cron expression for automation ${automation._id}: ${expression}`);
      return;
    }
    const task = cron.schedule(expression, () => {
      this.maybeRun(automation).catch((err) =>
        console.error(`Automation ${automation._id} (schedule) failed:`, err)
      );
    });
    this.cronTasks.set(automation._id.toString(), { task, woningId: automation.woning.toString() });
  }

  // Arms (or re-arms, e.g. after a backend restart) an in-memory countdown
  // for a 'timer'/'countdown' automation, firing at trigger.timerTargetAt.
  _armCountdown(automation) {
    const id = automation._id.toString();
    const existing = this.timerTimeouts.get(id);
    if (existing) clearTimeout(existing.handle);

    const remainingMs = automation.trigger.timerTargetAt.getTime() - Date.now();
    const handle = setTimeout(() => {
      this.timerTimeouts.delete(id);
      this._fireCountdown(id).catch((err) =>
        console.error(`Automation ${id} (timer) failed:`, err)
      );
    }, Math.max(remainingMs, 0));
    this.timerTimeouts.set(id, { handle, woningId: automation.woning.toString() });
  }

  // Re-fetches the automation so we act on its latest armed state (it may
  // have been disarmed or disabled after the timeout was scheduled), runs
  // the action, then disarms so the countdown is single-shot.
  async _fireCountdown(automationId) {
    const automation = await Automation.findById(automationId).populate('action.parameter');
    if (!automation || !automation.enabled) return;
    if (automation.trigger.type !== 'timer' || !automation.trigger.timerArmed) return;

    await this.maybeRun(automation);

    automation.trigger.timerArmed = false;
    automation.trigger.timerTargetAt = undefined;
    await automation.save();
  }

  async onReading(woningId, parameterId) {
    const automations = this.byWoning.get(woningId.toString()) || [];
    const parameterIdStr = parameterId.toString();
    const relevant = automations.filter(
      (a) =>
        a.trigger.type === 'state' &&
        a.conditions.some((c) => c.parameter.toString() === parameterIdStr)
    );
    for (const automation of relevant) {
      await this.maybeRun(automation).catch((err) =>
        console.error(`Automation ${automation._id} (state) failed:`, err)
      );
    }
  }

  async maybeRun(automation) {
    if (automation.lastTriggeredAt) {
      const elapsedMs = Date.now() - automation.lastTriggeredAt.getTime();
      if (elapsedMs < automation.cooldownMinutes * 60 * 1000) return;
    }

    const pass = await this.evaluateConditions(automation);
    if (pass) await this.runAction(automation);
  }

  async evaluateConditions(automation) {
    for (const condition of automation.conditions) {
      const latest = await Reading.findOne({ parameter: condition.parameter }).sort({
        timestamp: -1,
      });
      if (!latest || latest.value === null || latest.value === undefined) return false;
      if (!OPERATORS[condition.operator](latest.value, condition.value)) return false;
    }
    return true;
  }

  async runAction(automation) {
    // Deferred require: haConnectionManager triggers this engine (via
    // ingestService) on every reading, so requiring it at module load time
    // would create a circular-require deadlock. By the time an automation
    // actually fires, module loading has long finished.
    const { haConnectionManager } = require('./haConnectionManager');

    const parameter = automation.action.parameter;
    let result = 'success';
    let errorMessage;

    try {
      const client = haConnectionManager.getClient(automation.woning);
      if (!client) throw new Error('Home Assistant connection not available');

      const domain = parameter.controlDomain || parameter.entityId.split('.')[0];
      await client.callService(domain, automation.action.action, {
        entity_id: parameter.entityId,
        ...automation.action.payload,
      });
    } catch (err) {
      result = 'error';
      errorMessage = err.message;
    }

    automation.lastTriggeredAt = new Date();
    await automation.save();

    await CommandLog.create({
      woning: automation.woning,
      parameter: parameter._id,
      user: automation.createdBy,
      action: automation.action.action,
      payload: automation.action.payload,
      result,
      error: errorMessage,
      source: 'automation',
      automation: automation._id,
    }).catch((logErr) => console.error('Failed to write automation command log', logErr));
  }
}

const automationEngine = new AutomationEngine();

module.exports = { automationEngine, AutomationEngine };

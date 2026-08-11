const cron = require('node-cron');
const GlobalAutomation = require('../models/GlobalAutomation');
const Parameter = require('../models/Parameter');
const Reading = require('../models/Reading');
const Woning = require('../models/Woning');
const WoningUser = require('../models/WoningUser');
const { sendMail } = require('./mailer');

const OPERATORS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

/**
 * Mirrors AutomationEngine, but rules aren't scoped to one woning: conditions
 * match a parameter TYPE and are evaluated against every woning that has a
 * parameter of that type, with per-woning cooldown tracking.
 */
class GlobalAutomationEngine {
  constructor() {
    /** @type {any[]} enabled GlobalAutomation docs */
    this.automations = [];
    /** @type {Map<string, any>} automationId -> cron task */
    this.cronTasks = new Map();
  }

  async loadAll() {
    for (const entry of this.cronTasks.values()) entry.stop();
    this.cronTasks.clear();

    this.automations = await GlobalAutomation.find({ enabled: true });
    for (const automation of this.automations) {
      if (automation.trigger.type === 'schedule' && automation.trigger.cronExpression) {
        this._registerCron(automation);
      }
    }
  }

  _registerCron(automation) {
    const expression = automation.trigger.cronExpression;
    if (!cron.validate(expression)) {
      console.error(`Invalid cron expression for global automation ${automation._id}: ${expression}`);
      return;
    }
    const task = cron.schedule(expression, () => {
      this._runForAllWoningen(automation).catch((err) =>
        console.error(`Global automation ${automation._id} (schedule) failed:`, err)
      );
    });
    this.cronTasks.set(automation._id.toString(), task);
  }

  async _runForAllWoningen(automation) {
    const woningIds = await Woning.distinct('_id');
    for (const woningId of woningIds) {
      await this.maybeRun(automation, woningId).catch((err) =>
        console.error(`Global automation ${automation._id} for woning ${woningId} failed:`, err)
      );
    }
  }

  /** Called for every incoming reading (any woning), matched by parameter type. */
  async onReading(woningId, parameter) {
    const relevant = this.automations.filter(
      (a) =>
        a.trigger.type === 'state' && a.conditions.some((c) => c.parameterType === parameter.type)
    );
    for (const automation of relevant) {
      await this.maybeRun(automation, woningId).catch((err) =>
        console.error(`Global automation ${automation._id} (state) failed:`, err)
      );
    }
  }

  async maybeRun(automation, woningId) {
    const woningKey = woningId.toString();
    const last = automation.lastTriggeredByWoning?.get(woningKey);
    if (last) {
      const elapsedMs = Date.now() - last.getTime();
      if (elapsedMs < automation.cooldownMinutes * 60 * 1000) return;
    }

    const pass = await this.evaluateConditions(automation, woningKey);
    if (pass) await this.runAction(automation, woningKey);
  }

  async evaluateConditions(automation, woningId) {
    for (const condition of automation.conditions) {
      const parameters = await Parameter.find({ woning: woningId, type: condition.parameterType });
      if (parameters.length === 0) return false;

      let anyPass = false;
      for (const parameter of parameters) {
        const latest = await Reading.findOne({ parameter: parameter._id }).sort({ timestamp: -1 });
        if (!latest || latest.value === null || latest.value === undefined) continue;
        if (OPERATORS[condition.operator](latest.value, condition.value)) {
          anyPass = true;
          break;
        }
      }
      if (!anyPass) return false;
    }
    return true;
  }

  async runAction(automation, woningId) {
    const woning = await Woning.findById(woningId);
    if (woning) {
      const recipients = await this._resolveRecipients(automation, woningId);
      const subject = automation.action.subject || `TEMS: ${automation.name}`;
      const text = (automation.action.message || automation.name).replace(/\{\{woning\}\}/g, woning.name);
      await sendMail({ to: recipients, subject, text }).catch((err) =>
        console.error(`Failed to send e-mail for global automation ${automation._id}:`, err)
      );
    }

    if (!automation.lastTriggeredByWoning) automation.lastTriggeredByWoning = new Map();
    automation.lastTriggeredByWoning.set(woningId.toString(), new Date());
    automation.markModified('lastTriggeredByWoning');
    await automation.save();
  }

  async _resolveRecipients(automation, woningId) {
    if (automation.action.recipients === 'custom') {
      return automation.action.customEmails || [];
    }
    const roles = automation.action.recipients === 'woning_owners' ? ['owner'] : ['owner', 'member'];
    const links = await WoningUser.find({ woning: woningId, role: { $in: roles } }).populate(
      'user',
      'email active'
    );
    return links.filter((l) => l.user?.active).map((l) => l.user.email);
  }
}

const globalAutomationEngine = new GlobalAutomationEngine();

module.exports = { globalAutomationEngine, GlobalAutomationEngine };

// Validated default categorical palette (see dataviz skill references/palette.md).
// Fixed order — never cycled/reassigned dynamically.
export const CATEGORICAL = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aqua: '#1baf7a',
  yellow: '#eda100',
  magenta: '#e87ba4',
  green: '#008300',
  violet: '#4a3aa7',
  red: '#e34948',
};

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

// Fixed identity color per parameter type (categorical, not cycled).
export const PARAMETER_COLORS = {
  battery_soc: CATEGORICAL.blue,
  battery_power: CATEGORICAL.blue,
  ev_charger_power: CATEGORICAL.orange,
  ev_status: CATEGORICAL.orange,
  energy_consumption: CATEGORICAL.green,
  solar_power: CATEGORICAL.aqua,
  electricity_price: CATEGORICAL.yellow,
  grid_power: CATEGORICAL.magenta,
  switch_consumer: CATEGORICAL.green,
  switch_controllable: CATEGORICAL.violet,
  select_mode: CATEGORICAL.violet,
  number_controllable: CATEGORICAL.violet,
  custom: CATEGORICAL.red,
};

export function colorForType(type) {
  return PARAMETER_COLORS[type] || CATEGORICAL.blue;
}

export const WONING_STATUS_COLOR = {
  active: STATUS.good,
  paused: STATUS.warning,
  error: STATUS.critical,
};

import SwitchToggle from './SwitchToggle';
import SelectControl from './SelectControl';

// Picks the right control widget for a controllable parameter's type.
// Renders nothing for controllable types that don't have one yet.
export default function ControlWidget({ woningId, parameter }) {
  if (!parameter.controllable) return null;

  if (parameter.type === 'switch_controllable') {
    return <SwitchToggle woningId={woningId} parameter={parameter} />;
  }
  if (parameter.type === 'select_mode') {
    return <SelectControl woningId={woningId} parameter={parameter} />;
  }
  return null;
}

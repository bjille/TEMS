import { useSelector } from 'react-redux';
import SwitchToggle from './SwitchToggle';
import SelectControl from './SelectControl';
import NumberControl from './NumberControl';
import { selectAutomationsForWoning } from '../automations/automationsSlice';
import TimerWidget from '../automations/TimerWidget';

// Picks the right control widget for a controllable parameter's type, plus
// dashboard controls for any dynamic-timer automation targeting it.
export default function ControlWidget({ woningId, parameter }) {
  const automations = useSelector(selectAutomationsForWoning(woningId));
  const timerAutomations = automations.filter((a) => {
    if (!a.enabled || a.trigger.type !== 'timer') return false;
    const targetId = a.action.parameter?._id || a.action.parameter;
    return targetId === parameter._id;
  });

  if (!parameter.controllable) return null;

  return (
    <div>
      {parameter.type === 'switch_controllable' && <SwitchToggle woningId={woningId} parameter={parameter} />}
      {parameter.type === 'select_mode' && <SelectControl woningId={woningId} parameter={parameter} />}
      {parameter.type === 'number_controllable' && <NumberControl woningId={woningId} parameter={parameter} />}
      {timerAutomations.map((automation) => (
        <TimerWidget key={automation._id} woningId={woningId} automation={automation} />
      ))}
    </div>
  );
}

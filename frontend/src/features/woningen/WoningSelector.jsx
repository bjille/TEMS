import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchWoningen, selectWoning, selectWoningen, selectSelectedWoningId } from './woningenSlice';

export default function WoningSelector() {
  const dispatch = useDispatch();
  const woningen = useSelector(selectWoningen);
  const selectedId = useSelector(selectSelectedWoningId);

  useEffect(() => {
    dispatch(fetchWoningen());
  }, [dispatch]);

  const isSuperadmin = woningen[0]?.role === 'superadmin';

  // Regular users with a single woning have nothing to switch between; admins
  // always get the dropdown so they can toggle back to the overview.
  if (!isSuperadmin && woningen.length <= 1) {
    return woningen[0] ? <span className="muted">{woningen[0].name}</span> : null;
  }

  return (
    <select
      value={selectedId || ''}
      onChange={(e) => dispatch(selectWoning(e.target.value))}
      aria-label="Woning"
    >
      <option value="">Alle installaties</option>
      {woningen.map((w) => (
        <option key={w._id} value={w._id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}

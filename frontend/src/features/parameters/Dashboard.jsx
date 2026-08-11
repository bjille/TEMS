import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchParameters, selectParametersForWoning } from './parametersSlice';
import { selectSelectedWoningId, selectWoningen, selectWoning } from '../woningen/woningenSlice';
import { useLiveReadings } from './useLiveReadings';
import Tile from '../../components/Tile';
import ControlWidget from '../control/ControlWidget';
import { WONING_STATUS_COLOR } from '../../palette';

function WoningOverviewSection({ woning }) {
  const dispatch = useDispatch();
  const parameters = useSelector(selectParametersForWoning(woning._id));
  const favorites = parameters.filter((p) => p.favorite);

  useEffect(() => {
    dispatch(fetchParameters(woning._id));
  }, [woning._id, dispatch]);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-header" style={{ marginBottom: favorites.length ? 12 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="status-dot" style={{ background: WONING_STATUS_COLOR[woning.status] }} />
          <h2 style={{ margin: 0 }}>{woning.name}</h2>
        </div>
        <button className="btn btn-ghost" onClick={() => dispatch(selectWoning(woning._id))}>
          Bekijk alles →
        </button>
      </div>
      {favorites.length === 0 ? (
        <p className="muted">Geen favoriete parameters ingesteld voor deze woning.</p>
      ) : (
        <div className="grid">
          {favorites.map((parameter) => (
            <Tile key={parameter._id} parameter={parameter} woningId={woning._id}>
              <ControlWidget woningId={woning._id} parameter={parameter} />
            </Tile>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const dispatch = useDispatch();
  const woningId = useSelector(selectSelectedWoningId);
  const woningen = useSelector(selectWoningen);
  const parameters = useSelector(selectParametersForWoning(woningId));

  const overviewMode = woningen.length > 0 && !woningId;

  useLiveReadings(overviewMode ? woningen.map((w) => w._id) : woningId);

  useEffect(() => {
    if (woningId) dispatch(fetchParameters(woningId));
  }, [woningId, dispatch]);

  if (woningen.length === 0) {
    return <p className="muted">Je bent nog aan geen enkele woning gekoppeld.</p>;
  }

  if (overviewMode) {
    return (
      <div>
        <div className="section-header">
          <h1>Overzicht — alle installaties</h1>
        </div>
        {woningen.map((w) => (
          <WoningOverviewSection key={w._id} woning={w} />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="section-header">
        <h1>Dashboard</h1>
      </div>
      {parameters.length === 0 ? (
        <p className="muted">Nog geen parameters geconfigureerd voor deze woning.</p>
      ) : (
        <div className="grid">
          {parameters.map((parameter) => (
            <Tile key={parameter._id} parameter={parameter} woningId={woningId}>
              <ControlWidget woningId={woningId} parameter={parameter} />
            </Tile>
          ))}
        </div>
      )}
    </div>
  );
}

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { api } from '../../services/api';
import { fetchParameters, selectParametersForWoning } from '../parameters/parametersSlice';
import { selectSelectedWoningId, selectWoningen } from '../woningen/woningenSlice';
import {
  CostBarChart,
  formatBucketLabel,
  formatEuro,
  formatQty,
  withTrackerColors,
} from '../../components/CostChart';

const REFRESH_MS = 5 * 60 * 1000;
// While a calculation is still catching up, check back often so its
// progress and the resulting costs show up without a reload.
const BUSY_REFRESH_MS = 5 * 1000;

// A cumulative counter: an energy_meter, or anything counting kWh / m³ / l.
const isMeter = (p) => p.type === 'energy_meter' || /^(k?wh|m³|m3|l)$/i.test((p.unit || '').trim());
const isPrice = (p) => p.type === 'electricity_price' || p.type === 'gas_price' || (p.unit || '').includes('€');

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

const RANGES = {
  today: {
    label: 'Vandaag',
    interval: 'hour',
    range: () => {
      const from = startOfDay(new Date());
      return [from, new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1)];
    },
  },
  yesterday: {
    label: 'Gisteren',
    interval: 'hour',
    range: () => {
      const to = startOfDay(new Date());
      return [new Date(to.getFullYear(), to.getMonth(), to.getDate() - 1), to];
    },
  },
  month: {
    label: 'Deze maand',
    interval: 'day',
    range: () => {
      const now = new Date();
      return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)];
    },
  },
  lastMonth: {
    label: 'Vorige maand',
    interval: 'day',
    range: () => {
      const now = new Date();
      return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1)];
    },
  },
  year: {
    label: 'Dit jaar',
    interval: 'month',
    range: () => {
      const now = new Date();
      return [new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1)];
    },
  },
};

function formatUnitPrice(value, unit) {
  return typeof value === 'number' ? `${formatEuro(value, 3)}/${unit}` : '—';
}

function toDateInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A date input's "YYYY-MM-DD" as local midnight (not UTC midnight, which
// new Date("YYYY-MM-DD") would give).
function fromDateInput(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toISOString();
}

function SummaryCard({ tracker }) {
  const { totals, unit } = tracker;
  const diff =
    typeof totals.avgPaidPrice === 'number' && typeof totals.avgPrice === 'number'
      ? totals.avgPaidPrice - totals.avgPrice
      : null;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: 999, background: tracker.color }} />
        <h3 style={{ margin: 0 }}>{tracker.name}</h3>
      </div>
      <div style={{ fontSize: '2em', fontWeight: 600, margin: '8px 0 4px', fontVariantNumeric: 'tabular-nums' }}>
        {formatEuro(totals.cost)}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: '0.9em' }}>
        {formatQty(totals.quantity, unit)} · gem. {formatUnitPrice(totals.avgPaidPrice, unit)}
      </p>
      {diff !== null && (
        <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.85em' }}>
          Gemiddelde prijs in deze periode: {formatUnitPrice(totals.avgPrice, unit)} — je verbruikte gemiddeld{' '}
          {formatEuro(Math.abs(diff), 3)}/{unit} {diff <= 0 ? 'goedkoper' : 'duurder'}.
        </p>
      )}
    </div>
  );
}

function CostTable({ data }) {
  const buckets = data.trackers[0]?.buckets || [];
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th>Periode</th>
            {data.trackers.map((t) => (
              <th key={t._id} colSpan={2}>
                {t.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((b, i) => (
            <tr key={b.start}>
              <td>{formatBucketLabel(b.start, data.interval)}</td>
              {data.trackers.map((t) => (
                <Fragment key={t._id}>
                  <td>{formatQty(t.buckets[i].quantity, t.unit)}</td>
                  <td>{formatEuro(t.buckets[i].cost)}</td>
                </Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function emptyForm() {
  return {
    name: '',
    meterParameter: '',
    priceParameter: '',
    meterConversionFactor: '1',
    // Start of the year: hours before the sensors have any data simply
    // stay empty, so there's no harm in reaching back further than needed.
    validFrom: toDateInput(new Date(new Date().getFullYear(), 0, 1)),
  };
}

function TrackerForm({ woningId, parameters, tracker, onDone }) {
  const [form, setForm] = useState(() =>
    tracker
      ? {
          name: tracker.name,
          meterParameter: tracker.meterParameter?._id || '',
          priceParameter: tracker.priceParameter?._id || '',
          meterConversionFactor: String(tracker.meterConversionFactor ?? 1),
          validFrom: toDateInput(tracker.validFrom),
        }
      : emptyForm()
  );
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const meters = useMemo(() => parameters.filter(isMeter), [parameters]);
  const prices = useMemo(() => parameters.filter(isPrice), [parameters]);
  const meter = parameters.find((p) => p._id === form.meterParameter);
  const price = parameters.find((p) => p._id === form.priceParameter);
  // A meter counting m³ priced per kWh (gas) needs converting.
  const needsConversion = /m³|m3/i.test(meter?.unit || '') && /kwh/i.test(price?.unit || '');

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const payload = {
      name: form.name,
      meterParameter: form.meterParameter,
      priceParameter: form.priceParameter,
      meterConversionFactor: Number(form.meterConversionFactor) || 1,
      validFrom: fromDateInput(form.validFrom),
    };
    try {
      if (tracker) await api.patch(`/woningen/${woningId}/costs/trackers/${tracker._id}`, payload);
      else await api.post(`/woningen/${woningId}/costs/trackers`, payload);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Opslaan mislukt');
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit} style={{ maxWidth: 480 }}>
      <h3 style={{ marginTop: 0 }}>{tracker ? 'Kostenberekening wijzigen' : 'Nieuwe kostenberekening'}</h3>
      <div className="form-field">
        <label>Naam</label>
        <input
          placeholder="Elektriciteit van het net"
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          required
        />
      </div>
      <div className="form-field">
        <label>Verbruikssensor (teller)</label>
        <select value={form.meterParameter} onChange={(e) => set({ meterParameter: e.target.value })}>
          <option value="">— kies sensor —</option>
          {meters.map((p) => (
            <option key={p._id} value={p._id}>
              {p.label} {p.unit ? `(${p.unit})` : ''}
            </option>
          ))}
        </select>
        <p className="muted" style={{ fontSize: '0.8em', margin: '4px 0 0' }}>
          Een teller in kWh of m³, bv. de totale afname van je digitale meter. Een dagteller die
          elke nacht op 0 begint werkt ook.
        </p>
      </div>
      <div className="form-field">
        <label>Prijssensor (prijs van dit moment)</label>
        <select value={form.priceParameter} onChange={(e) => set({ priceParameter: e.target.value })}>
          <option value="">— kies sensor —</option>
          {prices.map((p) => (
            <option key={p._id} value={p._id}>
              {p.label} {p.unit ? `(${p.unit})` : ''}
            </option>
          ))}
        </select>
      </div>
      {(needsConversion || form.meterConversionFactor !== '1') && (
        <div className="form-field">
          <label>Omrekenfactor m³ → kWh</label>
          <input
            type="number"
            step="any"
            min="0"
            value={form.meterConversionFactor}
            onChange={(e) => set({ meterConversionFactor: e.target.value })}
          />
          <p className="muted" style={{ fontSize: '0.8em', margin: '4px 0 0' }}>
            De gasmeter telt m³, de prijs is per kWh. Vul de omrekenfactor van je factuur in
            (meestal 10–11 kWh/m³).
          </p>
        </div>
      )}
      <div className="form-field">
        <label>Berekenen vanaf</label>
        <input type="date" value={form.validFrom} onChange={(e) => set({ validFrom: e.target.value })} required />
        <p className="muted" style={{ fontSize: '0.8em', margin: '4px 0 0' }}>
          Verbruik en prijs komen uit de uurstatistieken van Home Assistant, die teruggaan tot
          wanneer HA de sensoren begon bij te houden — ook voor periodes waarin TEMS niet draaide.
        </p>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary"
          type="submit"
          disabled={!form.name || !form.meterParameter || !form.priceParameter || !form.validFrom}
        >
          {tracker ? 'Opslaan' : 'Toevoegen'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Annuleren
        </button>
      </div>
    </form>
  );
}

function isBusy(tracker) {
  if (!tracker.computedUntil) return true;
  // Complete hours only, so up to just over an hour behind is up to date.
  return Date.now() - new Date(tracker.computedUntil).getTime() > 2 * 3600 * 1000;
}

export default function CostsPage() {
  const dispatch = useDispatch();
  const woningId = useSelector(selectSelectedWoningId);
  const woningen = useSelector(selectWoningen);
  const woning = woningen.find((w) => w._id === woningId);
  const parameters = useSelector(selectParametersForWoning(woningId));
  const canManage = woning?.role === 'owner' || woning?.role === 'superadmin';

  const [rangeKey, setRangeKey] = useState('today');
  const [data, setData] = useState(null);
  const [trackers, setTrackers] = useState([]);
  const [error, setError] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const [editing, setEditing] = useState(null); // null | 'new' | tracker

  const load = useCallback(async () => {
    if (!woningId) return;
    const { interval, range } = RANGES[rangeKey];
    const [from, to] = range();
    try {
      const [costsRes, trackersRes] = await Promise.all([
        api.get(`/woningen/${woningId}/costs`, {
          params: { from: from.toISOString(), to: to.toISOString(), interval },
        }),
        api.get(`/woningen/${woningId}/costs/trackers`),
      ]);
      setData(withTrackerColors(costsRes.data));
      setTrackers(trackersRes.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Kon kosten niet laden');
    }
  }, [woningId, rangeKey]);

  useEffect(() => {
    if (woningId) dispatch(fetchParameters(woningId));
  }, [woningId, dispatch]);

  const busy = trackers.some(isBusy);
  useEffect(() => {
    load();
    const interval = setInterval(load, busy ? BUSY_REFRESH_MS : REFRESH_MS);
    return () => clearInterval(interval);
  }, [load, busy]);

  async function handleRecompute(tracker) {
    await api.post(`/woningen/${woningId}/costs/trackers/${tracker._id}/recompute`);
    load();
  }

  async function handleDelete(tracker) {
    if (!confirm(`Kostenberekening "${tracker.name}" verwijderen?`)) return;
    await api.delete(`/woningen/${woningId}/costs/trackers/${tracker._id}`);
    load();
  }

  if (!woningId) {
    return <p className="muted">Selecteer een specifieke woning via de dropdown om kosten te bekijken.</p>;
  }

  return (
    <div>
      <div className="section-header">
        <h1>Kosten</h1>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(RANGES).map(([key, r]) => (
            <button
              key={key}
              className={`btn${key === rangeKey ? ' btn-primary' : ''}`}
              onClick={() => setRangeKey(key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Per uur: hoeveel de verbruikssensor steeg, maal de prijs van de prijssensor in dat uur.
        Het lopende uur verschijnt kort nadat het afgelopen is.
      </p>

      {error && <p className="error-text">{error}</p>}
      {!data && !error && <p className="muted">Laden...</p>}

      {data && data.trackers.length > 0 && (
        <>
          <div className="grid" style={{ marginBottom: 16 }}>
            {data.trackers.map((t) => (
              <SummaryCard key={t._id} tracker={t} />
            ))}
          </div>
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="section-header" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>
                Kosten per {data.interval === 'hour' ? 'uur' : data.interval === 'day' ? 'dag' : 'maand'}
              </h3>
              <button className="btn btn-ghost" onClick={() => setShowTable((v) => !v)}>
                {showTable ? 'Toon grafiek' : 'Toon tabel'}
              </button>
            </div>
            {showTable ? <CostTable data={data} /> : <CostBarChart data={data} />}
          </div>
        </>
      )}

      <div className="section-header">
        <h2>Kostenberekeningen</h2>
        {canManage && !editing && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + Nieuwe berekening
          </button>
        )}
      </div>
      {editing ? (
        <TrackerForm
          woningId={woningId}
          parameters={parameters}
          tracker={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      ) : trackers.length === 0 ? (
        <p className="muted">Nog geen kostenberekening. Koppel een verbruikssensor aan een prijssensor om te starten.</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {trackers.map((t) => (
            <div key={t._id} className="card">
              <div className="section-header" style={{ marginBottom: 4 }}>
                <h3 style={{ margin: 0 }}>{t.name}</h3>
                {canManage && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn" onClick={() => setEditing(t)}>
                      Wijzigen
                    </button>
                    <button className="btn" onClick={() => handleRecompute(t)}>
                      Herberekenen
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDelete(t)}>
                      Verwijderen
                    </button>
                  </div>
                )}
              </div>
              <p className="muted" style={{ margin: 0, fontSize: '0.85em' }}>
                {t.meterParameter?.label} × {t.priceParameter?.label} · vanaf{' '}
                {new Date(t.validFrom).toLocaleDateString('nl-BE')} ·{' '}
                {isBusy(t)
                  ? `bezig met berekenen${t.computedUntil ? ` (klaar tot ${new Date(t.computedUntil).toLocaleString('nl-BE')})` : '...'}`
                  : `berekend tot ${new Date(t.computedUntil).toLocaleString('nl-BE')}`}
              </p>
              {t.lastError && (
                <p className="error-text" style={{ margin: '4px 0 0', fontSize: '0.85em' }}>
                  {t.lastError}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

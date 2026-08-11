import { Fragment, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchWoningen,
  createWoning,
  updateWoning,
  deleteWoning,
  selectWoningen,
} from '../woningen/woningenSlice';
import { WONING_STATUS_COLOR } from '../../palette';
import WoningUsersManager from './WoningUsersManager';

const emptyForm = { name: '', address: '', haBaseUrl: '', haToken: '' };

export default function AdminWoningen() {
  const dispatch = useDispatch();
  const woningen = useSelector(selectWoningen);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    dispatch(fetchWoningen());
  }, [dispatch]);

  function openCreateForm() {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
    setShowForm(true);
  }

  function openEditForm(woning) {
    setEditingId(woning._id);
    setForm({
      name: woning.name,
      address: woning.address || '',
      haBaseUrl: woning.haBaseUrl,
      haToken: '',
    });
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    try {
      if (editingId) {
        const { name, address, haBaseUrl, haToken } = form;
        await dispatch(
          updateWoning({ id: editingId, name, address, haBaseUrl, ...(haToken ? { haToken } : {}) })
        ).unwrap();
      } else {
        await dispatch(createWoning(form)).unwrap();
      }
      closeForm();
    } catch (err) {
      setError(err);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Deze woning en alle bijhorende data verwijderen?')) return;
    await dispatch(deleteWoning(id));
  }

  async function togglePause(woning) {
    await dispatch(
      updateWoning({ id: woning._id, status: woning.status === 'paused' ? 'active' : 'paused' })
    );
  }

  return (
    <div>
      <div className="section-header">
        <h2>Woningen</h2>
        <button className="btn btn-primary" onClick={() => (showForm ? closeForm() : openCreateForm())}>
          {showForm ? 'Annuleren' : '+ Nieuwe woning'}
        </button>
      </div>

      {showForm && (
        <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 20, maxWidth: 480 }}>
          <h3 style={{ marginTop: 0 }}>{editingId ? 'Woning wijzigen' : 'Nieuwe woning'}</h3>
          <div className="form-field">
            <label>Naam</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="form-field">
            <label>Adres (optioneel)</label>
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div className="form-field">
            <label>Home Assistant URL</label>
            <input
              placeholder="https://mijnwoning.duckdns.org"
              value={form.haBaseUrl}
              onChange={(e) => setForm({ ...form, haBaseUrl: e.target.value })}
              required
            />
          </div>
          <div className="form-field">
            <label>{editingId ? 'Nieuwe long-lived access token (optioneel)' : 'Long-lived access token'}</label>
            <input
              type="password"
              value={form.haToken}
              onChange={(e) => setForm({ ...form, haToken: e.target.value })}
              required={!editingId}
              placeholder={editingId ? 'Laat leeg om ongewijzigd te laten' : ''}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="btn btn-primary" type="submit">
            {editingId ? 'Opslaan' : 'Aanmaken'}
          </button>
        </form>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Naam</th>
            <th>HA URL</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {woningen.map((w) => (
            <Fragment key={w._id}>
              <tr>
                <td>
                  <button className="btn btn-ghost" onClick={() => setExpandedId(expandedId === w._id ? null : w._id)}>
                    {expandedId === w._id ? '▾' : '▸'} {w.name}
                  </button>
                </td>
                <td className="muted">{w.haBaseUrl}</td>
                <td>
                  <span className="status-pill">
                    <span className="status-dot" style={{ background: WONING_STATUS_COLOR[w.status] }} />
                    {w.status}
                  </span>
                </td>
                <td style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={() => togglePause(w)}>
                    {w.status === 'paused' ? 'Hervatten' : 'Pauzeren'}
                  </button>
                  <button className="btn" onClick={() => openEditForm(w)}>
                    Wijzigen
                  </button>
                  <button className="btn btn-danger" onClick={() => handleDelete(w._id)}>
                    Verwijderen
                  </button>
                </td>
              </tr>
              {expandedId === w._id && (
                <tr>
                  <td colSpan={4}>
                    <WoningUsersManager woningId={w._id} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

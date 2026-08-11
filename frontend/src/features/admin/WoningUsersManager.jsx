import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { api } from '../../services/api';
import { fetchUsers, selectAllUsers } from './adminUsersSlice';

export default function WoningUsersManager({ woningId }) {
  const dispatch = useDispatch();
  const allUsers = useSelector(selectAllUsers);
  const [links, setLinks] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState(null);

  useEffect(() => {
    dispatch(fetchUsers());
  }, [dispatch]);

  async function load() {
    const { data } = await api.get(`/woningen/${woningId}/users`);
    setLinks(data);
  }

  useEffect(() => {
    load();
  }, [woningId]);

  async function handleAdd(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/woningen/${woningId}/users`, { userId: selectedUserId, role });
      setSelectedUserId('');
      load();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Toevoegen mislukt');
    }
  }

  async function handleRemove(userId) {
    await api.delete(`/woningen/${woningId}/users/${userId}`);
    load();
  }

  const linkedUserIds = new Set(links.map((l) => l.user?._id));
  const available = allUsers.filter((u) => !linkedUserIds.has(u._id));

  return (
    <div className="card" style={{ marginTop: 4, marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Gekoppelde gebruikers</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Naam</th>
            <th>E-mail</th>
            <th>Rol</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l._id}>
              <td>{l.user?.name}</td>
              <td>{l.user?.email}</td>
              <td>{l.role}</td>
              <td>
                <button className="btn btn-danger" onClick={() => handleRemove(l.user._id)}>
                  Ontkoppelen
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
        <div className="form-field">
          <label>Gebruiker</label>
          <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} required>
            <option value="" disabled>
              Kies een gebruiker
            </option>
            {available.map((u) => (
              <option key={u._id} value={u._id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Rol</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">member</option>
            <option value="owner">owner</option>
          </select>
        </div>
        <button className="btn btn-primary" type="submit">
          Koppelen
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

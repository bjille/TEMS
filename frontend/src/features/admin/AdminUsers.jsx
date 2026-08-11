import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchUsers, createUser, updateUser, deleteUser, selectAllUsers } from './adminUsersSlice';

const emptyForm = { email: '', password: '', name: '', role: 'user' };

export default function AdminUsers() {
  const dispatch = useDispatch();
  const users = useSelector(selectAllUsers);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    dispatch(fetchUsers());
  }, [dispatch]);

  function openCreateForm() {
    setEditingId(null);
    setForm(emptyForm);
    setError(null);
    setShowForm(true);
  }

  function openEditForm(user) {
    setEditingId(user._id);
    setForm({ email: user.email, password: '', name: user.name, role: user.role });
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
        const { name, role, password } = form;
        await dispatch(
          updateUser({ id: editingId, name, role, ...(password ? { password } : {}) })
        ).unwrap();
      } else {
        await dispatch(createUser(form)).unwrap();
      }
      closeForm();
    } catch (err) {
      setError(err);
    }
  }

  async function toggleActive(user) {
    await dispatch(updateUser({ id: user._id, active: !user.active }));
  }

  async function handleDelete(id) {
    if (!confirm('Deze gebruiker verwijderen?')) return;
    await dispatch(deleteUser(id));
  }

  return (
    <div>
      <div className="section-header">
        <h2>Gebruikers</h2>
        <button className="btn btn-primary" onClick={() => (showForm ? closeForm() : openCreateForm())}>
          {showForm ? 'Annuleren' : '+ Nieuwe gebruiker'}
        </button>
      </div>

      {showForm && (
        <form className="card" onSubmit={handleSubmit} style={{ marginBottom: 20, maxWidth: 400 }}>
          <h3 style={{ marginTop: 0 }}>{editingId ? 'Gebruiker wijzigen' : 'Nieuwe gebruiker'}</h3>
          <div className="form-field">
            <label>Naam</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div className="form-field">
            <label>E-mail</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              disabled={!!editingId}
            />
          </div>
          <div className="form-field">
            <label>{editingId ? 'Nieuw wachtwoord (optioneel, min. 8 tekens)' : 'Wachtwoord (min. 8 tekens)'}</label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required={!editingId}
              minLength={8}
              placeholder={editingId ? 'Laat leeg om ongewijzigd te laten' : ''}
            />
          </div>
          <div className="form-field">
            <label>Rol</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">user</option>
              <option value="superadmin">superadmin</option>
            </select>
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
            <th>E-mail</th>
            <th>Rol</th>
            <th>Actief</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u._id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>
                <button className="btn" onClick={() => toggleActive(u)}>
                  {u.active ? 'Ja' : 'Nee'}
                </button>
              </td>
              <td style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => openEditForm(u)}>
                  Wijzigen
                </button>
                <button className="btn btn-danger" onClick={() => handleDelete(u._id)}>
                  Verwijderen
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

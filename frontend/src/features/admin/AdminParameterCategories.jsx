import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchParameterCategories,
  createParameterCategory,
  updateParameterCategory,
  deleteParameterCategory,
  selectParameterCategories,
} from '../parameters/parameterCategoriesSlice';

export default function AdminParameterCategories() {
  const dispatch = useDispatch();
  const categories = useSelector(selectParameterCategories);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    dispatch(fetchParameterCategories());
  }, [dispatch]);

  async function handleCreate(e) {
    e.preventDefault();
    setError(null);
    try {
      await dispatch(createParameterCategory(name)).unwrap();
      setName('');
    } catch (err) {
      setError(err);
    }
  }

  function startEdit(category) {
    setEditingId(category._id);
    setEditingName(category.name);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName('');
  }

  async function handleRename(e) {
    e.preventDefault();
    setError(null);
    try {
      await dispatch(updateParameterCategory({ id: editingId, name: editingName })).unwrap();
      setEditingId(null);
      setEditingName('');
    } catch (err) {
      setError(err);
    }
  }

  async function handleDelete(category) {
    if (
      !confirm(
        `Categorie "${category.name}" verwijderen? Parameters met deze categorie vallen terug op "Overig".`
      )
    )
      return;
    await dispatch(deleteParameterCategory(category._id));
  }

  return (
    <div>
      <div className="section-header">
        <h2>Categorieën</h2>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Deze lijst bepaalt welke categorieën je kan kiezen bij het aanmaken van een parameter of
        globale parameter, en wordt gebruikt om ze te groeperen en filteren bij het invoeren en op
        het dashboard.
      </p>

      <table className="table" style={{ marginBottom: 24, maxWidth: 480 }}>
        <thead>
          <tr>
            <th>Naam</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c._id}>
              {editingId === c._id ? (
                <td colSpan={2}>
                  <form style={{ display: 'flex', gap: 8 }} onSubmit={handleRename}>
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      autoFocus
                      required
                    />
                    <button className="btn btn-primary" type="submit">
                      Opslaan
                    </button>
                    <button className="btn" type="button" onClick={cancelEdit}>
                      Annuleren
                    </button>
                  </form>
                </td>
              ) : (
                <>
                  <td>{c.name}</td>
                  <td style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => startEdit(c)}>
                      Hernoemen
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDelete(c)}>
                      Verwijderen
                    </button>
                  </td>
                </>
              )}
            </tr>
          ))}
          {categories.length === 0 && (
            <tr>
              <td colSpan={2} className="muted">
                Nog geen categorieën aangemaakt.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <form className="card" onSubmit={handleCreate} style={{ maxWidth: 480 }}>
        <h3 style={{ marginTop: 0 }}>Nieuwe categorie</h3>
        <div className="form-field">
          <label>Naam</label>
          <input
            placeholder="bv. Batterij"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary" type="submit">
          Toevoegen
        </button>
      </form>
    </div>
  );
}

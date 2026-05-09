import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Table, Modal, message, Tooltip } from 'antd';
import {
  SearchOutlined, PlusOutlined,
  TagsOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { categoryAPI } from '../../api';
import useListSelection from '../../hooks/useListSelection';
import ActionStrip from '../../components/keyboard/ActionStrip';
import EntityFormModal from '../../components/EntityFormModal';
import './category-list.css';

const { Section, Field } = EntityFormModal;
const EMPTY_CAT = { category_name: '', category_code: '', parent_category_id: null };

export default function CategoryList() {
  const [allData,    setAllData]    = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');

  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing]         = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  // Replaced Antd Form with plain state — the EntityFormModal shell
  // owns the chrome and we own the field rendering. 3 fields, all
  // simple, no async validators, so manual handling is the cleanest
  // path.
  const [form, setForm]               = useState(EMPTY_CAT);
  const [initialForm, setInitialForm] = useState(EMPTY_CAT);
  const [formErrors, setFormErrors]   = useState({});

  const searchInputRef = useRef(null);

  useEffect(() => { loadCategories(); }, []);

  // Sidebar deep-link — /categories?new=1 from the "New Category"
  // entry. Open the modal every time the param appears, then strip
  // it. Dep on searchParams so revisiting the URL while already on
  // /categories also fires.
  //
  // Open synchronously (no setTimeout). A previous version deferred
  // the open via setTimeout + clearTimeout cleanup — but stripping
  // the search param re-fires the effect, the cleanup runs, and the
  // pending timeout is cancelled before the modal renders.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      openForm();
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams]);

  const loadCategories = async () => {
    setLoading(true);
    try {
      const { data } = await categoryAPI.getAll();
      // Flatten the tree → flat list with parent metadata + a `subCount`
      // attribute (nested children count), for the table + KPIs.
      const flat = [];
      const flatten = (nodes, parentName = null, parentId = null) => {
        (nodes || []).forEach(c => {
          flat.push({
            ...c,
            _parentName: parentName,
            _parentId:   parentId,
            _subCount:   c.subCategories?.length || 0,
          });
          if (c.subCategories?.length) flatten(c.subCategories, c.category_name, c.category_id);
        });
      };
      flatten(data);
      setAllData(flat);
    } catch { message.error('Failed to load categories'); }
    setLoading(false);
  };

  /* ── Filtered list (search only) ── */
  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return allData;
    return allData.filter(c => {
      const hay = `${c.category_name || ''} ${c.category_code || ''} ${c._parentName || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [allData, search]);

  /* ── Top-level categories (for the parent dropdown in the modal) ── */
  const topLevel = useMemo(() => allData.filter(c => !c._parentId), [allData]);

  /* ── Selection model — cursor + multi-select on the filtered list. */
  const sel = useListSelection({ totalCount: filtered.length, rows: filtered });
  const single = sel.activeRow;

  const openForm = (cat = null) => {
    setEditing(cat);
    const fresh = cat
      ? {
          category_name: cat.category_name || '',
          category_code: cat.category_code || '',
          parent_category_id: cat.parent_category_id ?? null,
        }
      : EMPTY_CAT;
    setForm(fresh);
    setInitialForm(fresh);
    setFormErrors({});
    setFormVisible(true);
  };

  const setField = (k) => (e) => {
    const v = e?.target ? e.target.value : e;
    setForm((p) => ({ ...p, [k]: v }));
    if (formErrors[k]) setFormErrors((er) => { const x = { ...er }; delete x[k]; return x; });
  };

  // Dirty detection — drives the Esc-confirm ribbon in the shell.
  const formDirty = useMemo(() => {
    return Object.keys(initialForm).some((k) => {
      const a = form[k], b = initialForm[k];
      return (a == null ? '' : String(a)) !== (b == null ? '' : String(b));
    });
  }, [form, initialForm]);

  const handleSubmit = async () => {
    const next = {};
    if (!(form.category_name || '').trim()) next.category_name = 'Required';
    setFormErrors(next);
    if (Object.keys(next).length) {
      message.warning('Fix the highlighted fields and try again');
      return;
    }
    setFormLoading(true);
    try {
      // Normalise undefined → null on the parent so the server's
      // hasOwnProperty(parent_category_id) update guard sees an
      // explicit "remove parent" signal rather than a missing key.
      const payload = {
        category_name: form.category_name.trim(),
        category_code: form.category_code || null,
        parent_category_id: form.parent_category_id ?? null,
      };
      if (editing) {
        await categoryAPI.update(editing.category_id, payload);
        message.success('Category updated');
      } else {
        await categoryAPI.create(payload);
        message.success('Category created');
      }
      setFormVisible(false);
      setEditing(null);
      await loadCategories();
    } catch (e) {
      message.error(e?.response?.data?.error || 'Failed to save');
    }
    setFormLoading(false);
  };

  const handleReset = useCallback(() => {
    setForm(initialForm);
    setFormErrors({});
  }, [initialForm]);

  const handleDelete = (cat) => {
    Modal.confirm({
      title: `Deactivate "${cat.category_name}"?`,
      okText: 'Deactivate', okType: 'danger',
      onOk: async () => {
        try {
          await categoryAPI.delete(cat.category_id);
          message.success('Deactivated');
          loadCategories();
        } catch (e) {
          message.error({ content: e.response?.data?.error || 'Failed to deactivate', duration: 6 });
        }
      },
    });
  };

  /* ── Antd table columns ── */
  const columns = [
    {
      key: 'name', title: 'Category Name', dataIndex: 'category_name',
      render: (v, c) => (
        <span className={`cl-name${c._parentId ? ' sub' : ''}`}>
          {c._parentId && <span className="indent">↳</span>}
          <TagsOutlined />
          {v}
        </span>
      ),
      sorter: (a, b) => (a.category_name || '').localeCompare(b.category_name || ''),
    },
    {
      key: 'code', title: 'Code', dataIndex: 'category_code', width: 160,
      render: (v) => v ? <span className="cl-code">{v}</span> : <span className="cl-muted">—</span>,
    },
    {
      key: 'parent', title: 'Parent', dataIndex: '_parentName', width: 200,
      render: (v) => v ? <span className="cl-parent-tag">{v}</span> : <span className="cl-muted">—</span>,
    },
    {
      key: 'subs', title: 'Sub-cats', dataIndex: '_subCount', width: 100, align: 'right',
      sorter: (a, b) => a._subCount - b._subCount,
      render: (v) => v > 0 ? <span className="cl-subcat-tag">{v}</span> : <span className="cl-muted">—</span>,
    },
    // (Per-row Edit + Deactivate buttons removed — both moved to the
    // bottom ActionStrip and operate on the cursored category.)
  ];

  return (
    <div className="cl-page">

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <div className="cl-hd">
        <div className="cl-title">
          <h1>Categories</h1>
        </div>
        <div className="cl-ctrls">
          <div className="cl-search">
            <SearchOutlined />
            <input
              ref={searchInputRef}
              placeholder="Search name, code, or parent…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
            />
          </div>
          <button className="cl-btn" onClick={loadCategories} title="Refresh">
            <ReloadOutlined /> Refresh
          </button>
          <button className="cl-btn primary" onClick={() => openForm()}>
            <PlusOutlined /> Add Category
          </button>
        </div>
      </div>

      {/* ── TABLE ──────────────────────────────────────────────── */}
      <div className="cl-tbl-wrap">
        <Table
          columns={columns}
          dataSource={filtered}
          rowKey="category_id"
          rowClassName={(c, idx) => {
            const base = c._parentId ? 'cl-row-sub' : '';
            const cur  = sel.cursorIdx === idx ? ' vrt-row-active'
                        : sel.selectedSet.has(idx) ? ' vrt-row-multi' : '';
            return base + cur;
          }}
          onRow={(record, index) => ({
            onClick: (e) => {
              if (e.shiftKey)               sel.extendTo(index);
              else if (e.ctrlKey || e.metaKey) sel.toggleRow(index);
              else                             sel.setCursor(index);
            },
            onDoubleClick: () => record && openForm(record),
          })}
          loading={loading && allData.length === 0}
          pagination={false}
          scroll={{ y: 'calc(100vh - 180px)' }}
          size="small"
          locale={{ emptyText: search ? 'No categories match the search' : 'No categories yet' }}
        />
      </div>

      {/* ── Action strip — F2 Edit · F3 New · F4 Find · F5 Refresh ·
          F8 Deactivate (danger). F1 = Edit (since "open" on a master
          list IS opening the edit form). Categories don't have a
          detail page distinct from the edit modal. */}
      <ActionStrip
        actions={[
          {
            id: 'edit', key: 'F2', label: 'Edit',
            disabled: !single,
            onAction: () => single && openForm(single),
          },
          {
            id: 'new', key: 'F3', label: 'New',
            onAction: () => openForm(),
          },
          {
            id: 'find', key: 'F4', label: 'Find',
            onAction: () => searchInputRef.current?.focus?.(),
          },
          {
            id: 'refresh', key: 'F5', label: 'Refresh',
            onAction: () => loadCategories(),
          },
          {
            id: 'deactivate', key: 'F8', label: 'Deactivate', tone: 'danger',
            disabled: !single,
            onAction: () => single && handleDelete(single),
          },
          {
            id: 'open', key: 'F1', label: 'Edit', tone: 'primary',
            disabled: !single,
            onAction: () => single && openForm(single),
          },
        ]}
      />

      {/* ── Add / Edit Modal — uses the shared EntityFormModal shell.
       *  Single section, three fields. Title flips to "Edit · …" in
       *  edit mode; tone is warning (amber) so it visually echoes the
       *  Tags icon used elsewhere for category surfaces. */}
      <EntityFormModal
        open={formVisible}
        onClose={() => { setFormVisible(false); setEditing(null); }}
        title={editing ? 'Edit Category' : 'Add Category'}
        subtitle={editing ? editing.category_name : 'Top-level inventory grouping'}
        entityIcon="C"
        entityTone="warning"
        dirty={formDirty}
        saving={formLoading}
        onSave={handleSubmit}
        onSaveAndClose={handleSubmit}
        onReset={handleReset}
        width={460}
      >
        <Section label="Category">
          <Field label="Category Name" required span="full" error={formErrors.category_name}
            help="Used in product master + reports drill-down">
            <input
              className={`efm-input${formErrors.category_name ? ' has-error' : ''}`}
              value={form.category_name}
              onChange={setField('category_name')}
              autoFocus
            />
          </Field>

          <Field label="Category Code" span="full" help="Optional · short code shown in pickers">
            <input className="efm-input" value={form.category_code} onChange={setField('category_code')} />
          </Field>

          <Field label="Parent Category" span="full" help="Leave blank for a top-level category">
            <select
              className="efm-select"
              value={form.parent_category_id ?? ''}
              onChange={(e) => setField('parent_category_id')(e.target.value ? parseInt(e.target.value, 10) : null)}
            >
              <option value="">— None (top-level) —</option>
              {topLevel
                .filter((c) => c.category_id !== editing?.category_id)
                .map((c) => (
                  <option key={c.category_id} value={c.category_id}>{c.category_name}</option>
                ))}
            </select>
          </Field>
        </Section>
      </EntityFormModal>
    </div>
  );
}

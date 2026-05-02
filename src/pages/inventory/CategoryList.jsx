import React, { useEffect, useMemo, useState } from 'react';
import { Table, Modal, Form, Input, Select, message, Tooltip } from 'antd';
import {
  SearchOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  TagsOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { categoryAPI } from '../../api';
import './category-list.css';

export default function CategoryList() {
  const [allData,    setAllData]    = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');

  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing]         = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => { loadCategories(); }, []);

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

  const openForm = (cat = null) => {
    setEditing(cat);
    if (cat) {
      form.setFieldsValue({
        category_name: cat.category_name,
        category_code: cat.category_code,
        parent_category_id: cat.parent_category_id,
      });
    } else {
      form.resetFields();
    }
    setFormVisible(true);
  };

  const handleSubmit = async () => {
    setFormLoading(true);
    try {
      const values = await form.validateFields();
      // Antd's Select with allowClear returns `undefined` when cleared,
      // which JSON.stringify drops on the wire. Normalise to `null` so
      // the server explicitly receives the "remove parent" signal — its
      // update guard uses hasOwnProperty(parent_category_id) to decide
      // whether to touch the field.
      const payload = {
        ...values,
        parent_category_id: values.parent_category_id ?? null,
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
      // Antd form-validation errors don't have a `response` — only show
      // the toast for backend failures.
      if (e?.response) message.error(e.response.data?.error || 'Failed to save');
    }
    setFormLoading(false);
  };

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
    {
      key: 'actions', title: 'Actions', width: 110, align: 'right',
      render: (_, c) => (
        <span className="cl-row-actions">
          <Tooltip title="Edit">
            <button className="cl-row-btn" onClick={() => openForm(c)}><EditOutlined /></button>
          </Tooltip>
          <Tooltip title="Deactivate">
            <button className="cl-row-btn danger" onClick={() => handleDelete(c)}><DeleteOutlined /></button>
          </Tooltip>
        </span>
      ),
    },
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
          rowClassName={(c) => c._parentId ? 'cl-row-sub' : ''}
          loading={loading && allData.length === 0}
          pagination={false}
          scroll={{ y: 'calc(100vh - 180px)' }}
          size="small"
          locale={{ emptyText: search ? 'No categories match the search' : 'No categories yet' }}
        />
      </div>

      {/* ── Add / Edit Modal ── */}
      <Modal
        title={editing ? `Edit · ${editing.category_name}` : 'Add Category'}
        open={formVisible}
        onCancel={() => { setFormVisible(false); setEditing(null); }}
        onOk={handleSubmit}
        confirmLoading={formLoading}
        okText={editing ? 'Update' : 'Add Category'}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="category_name" label="Category Name" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="e.g. Frock, Jeans, T-Shirt" autoFocus />
          </Form.Item>
          <Form.Item name="category_code" label="Category Code">
            <Input placeholder="Optional short code" />
          </Form.Item>
          <Form.Item name="parent_category_id" label="Parent Category">
            <Select placeholder="None (top-level)" allowClear showSearch optionFilterProp="label"
              options={topLevel
                .filter(c => c.category_id !== editing?.category_id)
                .map(c => ({ value: c.category_id, label: c.category_name }))
              }
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

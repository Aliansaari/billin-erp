import React, { useEffect, useState } from 'react';
import { Table, Button, Input, Space, Tag, Typography, message, Popconfirm, Card, Modal, Form, Select, Switch } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { settingsAPI } from '../../api';

const { Title } = Typography;

const ROLE_COLORS = {
  Admin: 'red',
  Manager: 'blue',
  Accountant: 'green',
  Salesperson: 'orange',
  Viewer: 'default',
};

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, rolesRes] = await Promise.all([
        settingsAPI.getUsers(),
        settingsAPI.getRoles(),
      ]);
      setUsers(usersRes.data.data || []);
      setRoles(rolesRes.data.data || []);
    } catch (error) {
      message.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingUser(record);
    form.setFieldsValue({
      username: record.username,
      full_name: record.full_name,
      email: record.email,
      mobile_number: record.mobile_number,
      role_id: record.role_id,
    });
    setModalVisible(true);
  };

  const handleDelete = async (id) => {
    try {
      await settingsAPI.deleteUser(id);
      message.success('User deleted');
      loadData();
    } catch (error) {
      message.error('Failed to delete user');
    }
  };

  const handleToggleStatus = async (record) => {
    try {
      await settingsAPI.updateUser(record.user_id, { is_active: !record.is_active });
      message.success('User status updated');
      loadData();
    } catch (error) {
      message.error('Failed to update status');
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setFormLoading(true);
      if (editingUser) {
        if (!values.password) delete values.password;
        await settingsAPI.updateUser(editingUser.user_id, values);
        message.success('User updated');
      } else {
        await settingsAPI.createUser(values);
        message.success('User created');
      }
      setModalVisible(false);
      form.resetFields();
      setEditingUser(null);
      loadData();
    } catch (error) {
      if (error.errorFields) return;
      message.error('Failed to save user');
    } finally {
      setFormLoading(false);
    }
  };

  const getRoleName = (roleId) => {
    const role = roles.find(r => r.role_id === roleId);
    return role ? role.role_name : '-';
  };

  const columns = [
    { title: 'Username', dataIndex: 'username', key: 'username' },
    { title: 'Full Name', dataIndex: 'full_name', key: 'full_name' },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    { title: 'Mobile', dataIndex: 'mobile_number', key: 'mobile_number' },
    {
      title: 'Role',
      dataIndex: 'role_id',
      key: 'role',
      render: (roleId) => {
        const name = getRoleName(roleId);
        return <Tag color={ROLE_COLORS[name] || 'default'}>{name}</Tag>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      key: 'status',
      render: (active, record) => (
        <Switch
          checked={active}
          checkedChildren="Active"
          unCheckedChildren="Inactive"
          onChange={() => handleToggleStatus(record)}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            Edit
          </Button>
          <Popconfirm
            title="Are you sure you want to delete this user?"
            onConfirm={() => handleDelete(record.user_id)}
            okText="Yes"
            cancelText="No"
          >
            <Button type="link" danger icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="erp-list-header">
        <Title level={3} style={{ margin: 0 }}>User Management</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Add User
        </Button>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={users}
          rowKey="user_id"
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title={editingUser ? 'Edit User' : 'Add User'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => { setModalVisible(false); form.resetFields(); setEditingUser(null); }}
        confirmLoading={formLoading}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="username"
            label="Username"
            rules={[{ required: true, message: 'Please enter username' }]}
          >
            <Input placeholder="Enter username" disabled={!!editingUser} />
          </Form.Item>

          <Form.Item
            name="password"
            label="Password"
            rules={editingUser ? [] : [{ required: true, message: 'Please enter password' }]}
          >
            <Input.Password placeholder={editingUser ? 'Leave blank to keep current' : 'Enter password'} />
          </Form.Item>

          <Form.Item
            name="full_name"
            label="Full Name"
            rules={[{ required: true, message: 'Please enter full name' }]}
          >
            <Input placeholder="Enter full name" />
          </Form.Item>

          <Form.Item
            name="email"
            label="Email"
            rules={[{ type: 'email', message: 'Please enter a valid email' }]}
          >
            <Input placeholder="Enter email" />
          </Form.Item>

          <Form.Item name="mobile_number" label="Mobile Number">
            <Input placeholder="Enter mobile number" />
          </Form.Item>

          <Form.Item
            name="role_id"
            label="Role"
            rules={[{ required: true, message: 'Please select a role' }]}
          >
            <Select placeholder="Select role">
              {roles.map(role => (
                <Select.Option key={role.role_id} value={role.role_id}>
                  {role.role_name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

import React from 'react';
import { Button, List, NavBar } from 'antd-mobile';
import useAuthStore from '../../store/authStore';

export default function SalesmanHome() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="mobile-screen">
      <NavBar
        back={null}
        right={<Button size="mini" onClick={logout}>Logout</Button>}
        className="safe-area-top"
      >
        {`Hi, ${user?.full_name || user?.username || 'Salesman'}`}
      </NavBar>
      <div className="mobile-screen-body" style={{ padding: 12 }}>
        <List header="Quick Actions">
          <List.Item arrow extra="Coming soon">New Sale (Scan Items)</List.Item>
          <List.Item arrow extra="Coming soon">Collect Payment</List.Item>
          <List.Item arrow extra="Coming soon">Customer Ledger</List.Item>
          <List.Item arrow extra="Coming soon">Today's Sales</List.Item>
        </List>
      </div>
    </div>
  );
}

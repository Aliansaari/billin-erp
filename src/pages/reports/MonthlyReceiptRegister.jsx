// Thin wrapper — see ./MonthlySummary.jsx for the shared body.
import React from 'react';
import MonthlyRegister from './MonthlySummary';
import './monthly-summary.css';
export default function MonthlyReceiptRegister() { return <MonthlyRegister mode="receipt" />; }

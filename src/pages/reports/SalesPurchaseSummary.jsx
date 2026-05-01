// Thin wrapper — see ./MonthlySummary.jsx for the shared body.
import React from 'react';
import MonthlySummary from './MonthlySummary';
import './monthly-summary.css';
export default function SalesPurchaseSummary() { return <MonthlySummary side="combined" />; }

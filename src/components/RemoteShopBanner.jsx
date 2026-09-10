import React, { useState } from 'react';
import { Modal } from 'antd';
import { CloudServerOutlined, HomeOutlined } from '@ant-design/icons';
import { getRemoteShop, returnHome } from '../utils/remoteShop';
import './remote-shop-banner.css';

/* ──────────────────────────────────────────────────────────────────────
 * RemoteShopBanner — the strip that says whose books you are writing into.
 *
 * Mounted once in AppLayout, directly under the nav, and it is not
 * dismissible. Every other piece of chrome on this screen looks identical
 * whether you are in your own shop or another one: same company name in the
 * switcher, same sidebar, same bill form. The one thing that differs is where
 * the save goes.
 *
 * A purchase entered into the wrong shop's books is not an undo-able mistake —
 * it moves stock and money in a business that is not in front of you — so this
 * is the one banner in the app that is louder than it is pretty.
 * ────────────────────────────────────────────────────────────────────── */

export default function RemoteShopBanner() {
  const [leaving, setLeaving] = useState(false);
  const shop = getRemoteShop();
  if (!shop) return null;

  const goHome = () => {
    Modal.confirm({
      title: 'Return to this computer?',
      content: `You will leave ${shop.name} and go back to the shop on this machine. Anything you have not saved there will be lost.`,
      okText: 'Return',
      cancelText: 'Stay',
      onOk: () => {
        setLeaving(true);
        returnHome();
        // Hard navigation, not a re-render: every store on screen holds the
        // other shop's parties, products and open day book, and swapping the
        // base URL underneath them would leave one shop's figures on screen
        // while writes went to another.
        window.location.replace('/');
      },
    });
  };

  return (
    <div className="erp-remote-banner" role="status" aria-live="polite">
      <CloudServerOutlined className="erp-remote-icon" aria-hidden="true" />
      <span className="erp-remote-text">
        You are working in <strong>{shop.name}</strong> over the internet —
        everything you save goes into that shop’s books, not this computer’s.
      </span>
      <button
        type="button"
        className="erp-remote-home"
        onClick={goHome}
        disabled={leaving}
      >
        <HomeOutlined aria-hidden="true" /> {leaving ? 'Returning…' : 'Return to this computer'}
      </button>
    </div>
  );
}

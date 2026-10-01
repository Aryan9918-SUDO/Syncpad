import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import { WebsocketProvider } from 'y-websocket';
import SharePanel from './SharePanel';

const LANG_MAP = {
  javascript: javascript,
  python: python,
  html: html,
  css: css,
  json: json,
};

const COLORS = ['#f38ba8', '#a6e3a1', '#89b4fa', '#fab387', '#f9e2af', '#cba6f7', '#94e2d5', '#eba0ac'];

function getColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

export default function Editor({ docId, token, user, onBack }) {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const providerRef = useRef(null);
  const langCompartment = useRef(new Compartment());
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState([]);
  const [docInfo, setDocInfo] = useState(null);
  const [showShare, setShowShare] = useState(false);

  useEffect(() => {
    fetch(`/api/documents/${docId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then(setDocInfo);
  }, [docId, token]);

  const handleLanguageChange = useCallback(async (newLang) => {
    const langExt = LANG_MAP[newLang] || javascript;
    if (viewRef.current) {
      viewRef.current.dispatch({
        effects: langCompartment.current.reconfigure(langExt()),
      });
    }
    setDocInfo((prev) => ({ ...prev, language: newLang }));
    await fetch(`/api/documents/${docId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ language: newLang }),
    });
  }, [docId, token]);

  useEffect(() => {
    if (!editorRef.current || !docInfo) return;

    const ydoc = new Y.Doc();
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/yjs`;
    const provider = new WebsocketProvider(wsUrl, docId, ydoc);
    providerRef.current = provider;

    const ytext = ydoc.getText('codemirror');

    const color = getColor(user.username);
    provider.awareness.setLocalStateField('user', {
      name: user.username,
      color: color,
      colorLight: color + '40',
    });

    provider.on('status', ({ status }) => {
      setConnected(status === 'connected');
    });

    provider.awareness.on('change', () => {
      const states = Array.from(provider.awareness.getStates().values());
      const userPeers = states.filter((s) => s.user).map((s) => s.user);
      setPeers(userPeers);
    });

    const langExt = LANG_MAP[docInfo.language] || javascript;

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        langCompartment.current.of(langExt()),
        oneDark,
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': {
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            fontSize: '14px',
            lineHeight: '1.6',
          },
        }),
        yCollab(ytext, provider.awareness),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      provider.disconnect();
      ydoc.destroy();
    };
  }, [docInfo?.id]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button className="secondary" onClick={onBack} style={{ padding: '6px 14px', fontSize: '0.85rem' }}>
            Back
          </button>
          <h1>{docInfo?.title || 'Loading...'}</h1>
          <select
            value={docInfo?.language || 'javascript'}
            onChange={(e) => handleLanguageChange(e.target.value)}
            style={{ padding: '4px 8px', fontSize: '0.8rem' }}
          >
            <option value="javascript">JavaScript</option>
            <option value="python">Python</option>
            <option value="html">HTML</option>
            <option value="css">CSS</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <div className="doc-info">
          <div className="collaborators">
            {peers.map((p, i) => (
              <div
                key={i}
                className="collaborator-badge"
                style={{ background: p.color }}
                title={p.name}
              >
                {p.name.charAt(0).toUpperCase()}
              </div>
            ))}
          </div>
          <button
            className="secondary"
            onClick={() => setShowShare(!showShare)}
            style={{ padding: '6px 14px', fontSize: '0.8rem' }}
          >
            Share
          </button>
          <span className={`status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
      {showShare && (
        <SharePanel docId={docId} token={token} onClose={() => setShowShare(false)} />
      )}
      <div className="editor-container" ref={editorRef} style={{ flex: 1 }} />
    </div>
  );
}

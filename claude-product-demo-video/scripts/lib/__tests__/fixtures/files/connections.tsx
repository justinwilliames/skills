import { useState } from 'react';
import { Badge, Button } from '../ui';

export default function ConnectionsPage() {
  const [query, setQuery] = useState('');

  return (
    <main className="connections-page">
      <h1>Connections</h1>
      <p>Link the tools your team already uses.</p>
      <Badge tone="info">Beta</Badge>
      <input aria-label="Search connections" placeholder="Search connections" value={query} />
      <Button onClick={connectAccount}>Connect account</Button>
      <button className="secondary">Disconnect</button>
      <p>No connections yet. Connect your first account to get started.</p>
    </main>
  );
}

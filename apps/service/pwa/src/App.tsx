import { Route, Switch, Redirect } from 'wouter';
import { AuthGate } from './api/AuthGate.js';
import { AppShell } from './components/AppShell.js';
import { useServerEvents } from './sse/useServerEvents.js';
import { NeedsAttention } from './routes/NeedsAttention.js';
import { FollowUps } from './routes/FollowUps.js';
import { Inbox } from './routes/Inbox.js';
import { Contacts } from './routes/Contacts.js';
import { Settings } from './routes/Settings.js';
import { ThreadView } from './routes/ThreadView.js';

function Routes(): JSX.Element {
  useServerEvents();
  return (
    <AppShell>
      <Switch>
        <Route path="/needs-attention" component={NeedsAttention} />
        <Route path="/followups" component={FollowUps} />
        <Route path="/inbox" component={Inbox} />
        <Route path="/contacts" component={Contacts} />
        <Route path="/settings" component={Settings} />
        <Route path="/threads/:id">{(p) => <ThreadView id={p.id ?? ''} />}</Route>
        <Route>
          <Redirect to="/needs-attention" />
        </Route>
      </Switch>
    </AppShell>
  );
}

export function App(): JSX.Element {
  return (
    <AuthGate>
      <Routes />
    </AuthGate>
  );
}

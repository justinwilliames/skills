import { Button } from '../ui';

export default function BillingPage() {
  return (
    <section className="billing">
      <h1>Billing</h1>
      <p>Your plan renews on the first of each month.</p>
      <Button onClick={openPortal}>Update payment method</Button>
      <a href="/invoices">Invoices</a>
    </section>
  );
}

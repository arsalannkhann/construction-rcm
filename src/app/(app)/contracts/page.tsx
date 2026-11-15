import { redirect } from 'next/navigation';

/** Subcontracts are reached through their project; there is no separate list of them. */
export default function ContractsPage() {
  redirect('/projects');
}

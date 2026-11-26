import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import Send from 'lucide-react-native/icons/send';
import { api, messageOf } from '@/lib/api';
import { useInvalidate } from '@/lib/queries';
import { usePalette } from '@/theme';
import { Banner, Button, Card, Field, LoadingCard, Screen, T } from '@/ui/kit';
import { useOnline } from '@/ui/parts';

type Draft = { to: string; subject: string; body: string };
type Result = { status: 'sent' | 'not_sent' | 'failed' | 'unconfirmed'; detail: string | null };

/** Ask the subcontractor for corrections, starting from Zephric’s draft of the open findings. */
export default function RequestInfo() {
  const p = usePalette();
  const { id } = useLocalSearchParams<{ id: string }>();
  const online = useOnline();
  const invalidate = useInvalidate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hold, setHold] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Draft>(`/api/mobile/applications/${id}/request-info`)
      .then(setDraft)
      .catch((err) => setError(messageOf(err)));
  }, [id]);

  const send = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const result = await api<Result>(`/api/mobile/applications/${id}/request-info`, { method: 'POST', body: { ...draft, hold }, timeoutMs: 45_000 });
      await invalidate();
      const outcome: Record<Result['status'], [string, string]> = {
        sent: ['Request sent', 'The email was accepted for delivery.'],
        not_sent: ['Saved, not emailed', 'Email is not set up for your company, so the request was saved on the bill but not emailed. Send it yourself from your email.'],
        failed: ['Not sent', result.detail ?? 'The email could not be sent. It is saved on the bill.'],
        unconfirmed: ['Delivery not confirmed', 'No answer came back from the email provider. It may or may not have been sent; check before sending again.'],
      };
      const [title, body] = outcome[result.status];
      Alert.alert(title, body, [{ text: 'OK', onPress: () => router.back() }]);
    } catch (err) {
      Alert.alert('Not sent', messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {error ? <Banner tone="block">{error}</Banner> : null}
      {!draft && !error ? <LoadingCard rows={3} /> : null}
      {draft ? (
        <>
          <T v="caption" tone="ink3">
            Zephric wrote this from the problems it found. Change anything you like before sending
          </T>
          <Field label="To" value={draft.to} onChangeText={(to) => setDraft({ ...draft, to })} autoCapitalize="none" keyboardType="email-address" autoCorrect={false} />
          <Field label="Subject" value={draft.subject} onChangeText={(subject) => setDraft({ ...draft, subject })} />
          <Field label="Message" value={draft.body} onChangeText={(body) => setDraft({ ...draft, body })} multiline style={{ minHeight: 260 }} />
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="label">Put this bill on hold</T>
              <T v="caption" tone="ink3">
                It waits for the subcontractor until they reply
              </T>
            </View>
            <Switch value={hold} onValueChange={setHold} trackColor={{ true: p.accent, false: p.lineStrong }} />
          </Card>
          <Button label="Send" icon={Send} onPress={send} loading={busy} disabled={!online} size="lg" />
          {!online ? (
            <T v="caption" tone="ink3" style={{ textAlign: 'center' }}>
              Sending needs internet
            </T>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

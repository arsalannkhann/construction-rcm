import { router } from 'expo-router';
import Compass from 'lucide-react-native/icons/compass';
import { Button, Card, Empty, Screen } from '@/ui/kit';

export default function NotFound() {
  return (
    <Screen>
      <Card>
        <Empty icon={Compass} title="This screen does not exist" action={<Button label="Go to overview" onPress={() => router.replace('/')} />}>
          The link may be out of date.
        </Empty>
      </Card>
    </Screen>
  );
}

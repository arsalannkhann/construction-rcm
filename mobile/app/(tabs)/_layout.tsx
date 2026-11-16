import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';
import Bell from 'lucide-react-native/icons/bell';
import Building2 from 'lucide-react-native/icons/building-complex';
import CircleUser from 'lucide-react-native/icons/circle-user';
import House from 'lucide-react-native/icons/house';
import ReceiptText from 'lucide-react-native/icons/receipt-text';
import { useHome } from '@/lib/queries';
import { usePalette } from '@/theme';

export default function TabsLayout() {
  const p = usePalette();
  const home = useHome();
  const unread = home.data?.unread ?? 0;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: p.scheme === 'dark' ? p.ink : p.accentText,
        tabBarInactiveTintColor: p.ink3,
        tabBarStyle: { backgroundColor: p.surface, borderTopColor: p.line, borderTopWidth: StyleSheet.hairlineWidth },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: p.canvas },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Overview', tabBarIcon: ({ color, size }) => <House color={color} size={size - 2} /> }} />
      <Tabs.Screen name="projects" options={{ title: 'Projects', tabBarIcon: ({ color, size }) => <Building2 color={color} size={size - 2} /> }} />
      <Tabs.Screen name="billing" options={{ title: 'Billing', tabBarIcon: ({ color, size }) => <ReceiptText color={color} size={size - 2} /> }} />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: ({ color, size }) => <Bell color={color} size={size - 2} />,
          tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
          tabBarBadgeStyle: { backgroundColor: p.block, color: '#fff', fontSize: 10 },
        }}
      />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ color, size }) => <CircleUser color={color} size={size - 2} /> }} />
    </Tabs>
  );
}

import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function NotificationsRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    if (!router.isReady) return;
    const storeId = typeof router.query.storeId === 'string' ? router.query.storeId : undefined;
    void router.replace({
      pathname: '/',
      query: { tab: 'NOTIFICATIONS', ...(storeId ? { storeId } : {}) }
    });
  }, [router]);
  return null;
}

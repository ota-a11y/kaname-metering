import type { UserProfile } from '../types';

/** 検針アプリ固有の認可窓口。現在はKANAMEのactiveユーザーをすべて許可する。 */
export function canAccessMetering(profile: UserProfile | null): boolean {
  return profile?.account_status === 'active';
}

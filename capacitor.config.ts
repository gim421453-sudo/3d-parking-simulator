import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.parkingsim.app',
  appName: '3D 주차 시뮬레이터',
  webDir: 'dist',
  android: { allowMixedContent: false },
  backgroundColor: '#10151c',
};

export default config;

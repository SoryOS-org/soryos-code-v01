const base = {
  ios: {
    bundleIdentifier: 'com.yourcompany.vibracode',
    supportsTablet: false,
  },
  android: {
    package: 'com.yourcompany.vibracode',
  },
  updates: {
    url: 'https://u.expo.dev/b733e6a0-be68-4bec-b0d0-9debc364dc7d',
  },
  runtimeVersion: '54.0.0',
};

const mapBuildProfileToConfig = {
  'versioned-client-add-sdk': {
    ...base,
    slug: 'vibra-code-versioned-add-sdk',
    name: 'Vibra Code (versioned) + add sdk',
    owner: 'soryos-621s-org',
    extra: {
      eas: {
        projectId: 'b733e6a0-be68-4bec-b0d0-9debc364dc7d',
      },
    },
  },
  'versioned-client': {
    ...base,
    slug: 'vibra-code',
    name: 'Vibra Code (versioned)',
    owner: 'soryos-621s-org',
    extra: {
      eas: {
        projectId: 'b733e6a0-be68-4bec-b0d0-9debc364dc7d',
      },
    },
  },
  'unversioned-client': {
    ...base,
    slug: 'vibra-code',
    name: 'Vibra Code (unversioned)',
    owner: 'soryos-621s-org',
    extra: {
      eas: {
        projectId: 'b733e6a0-be68-4bec-b0d0-9debc364dc7d',
      },
    },
  },
  'release-client': {
    ...base,
    slug: 'vibra-code',
    name: 'Vibra Code',
    owner: 'soryos-621s-org',
    extra: {
      eas: {
        projectId: 'b733e6a0-be68-4bec-b0d0-9debc364dc7d',
      },
    },
  },
  'publish-client': {
    ...base,
    slug: 'vibra-code',
    name: 'Vibra Code',
    owner: 'soryos-621s-org',
    extra: {
      eas: {
        projectId: 'b733e6a0-be68-4bec-b0d0-9debc364dc7d',
      },
    },
  },
  production: {
    ...base,
    slug: 'vibra-code',
    name: 'Vibra Code',
    owner: 'soryos-621s-org',
    extra: {
      eas: {
        projectId: 'b733e6a0-be68-4bec-b0d0-9debc364dc7d',
      },
    },
  },
};

const buildType = process.env.EAS_BUILD_PROFILE || 'release-client';
const config = mapBuildProfileToConfig[buildType] || mapBuildProfileToConfig['release-client'];

export default config;

module.exports = {
  dependencies: {
    // The app's own package is named `@expo/home`, so workspace symlinking makes
    // autolinking treat it as a dependency whose android dir is the app's own
    // android dir (which collides with the root Gradle project). Exclude it.
    '@expo/home': {
      platforms: {
        ios: null,
        android: null,
      },
    },
    // `apps/eas-expo-go` is an EAS host project: yarn workspaces symlink it into
    // node_modules, and its `android` is a symlink to this app's own android dir.
    // Autolinking then treats it as a native dependency and derives a bogus
    // `import host.exp.exponent.ExponentPackage;` (that class only exists as
    // versioned.host.exp.exponent.ExponentPackage), breaking :app PackageList.
    'eas-expo-go': {
      platforms: {
        ios: null,
        android: null,
      },
    },
    // Exclude Stripe on iOS to avoid PassKit framework inclusion (App Store rejection).
    // Android must stay enabled: expoview (versioned/host/exp/exponent/ExponentPackage.kt)
    // imports com.reactnativestripesdk.StripeSdkPackage and autolinks it via autolinkLibrariesWithApp().
    '@stripe/stripe-react-native': {
      platforms: {
        ios: null,
      },
    },
  },
};

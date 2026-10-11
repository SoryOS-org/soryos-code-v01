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

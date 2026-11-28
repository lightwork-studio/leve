Pod::Spec.new do |s|
  s.name           = 'LeveActivityBackground'
  s.version        = '1.0.0'
  s.summary        = 'Scene-independent Live Activity startup'
  s.description    = 'Starts the Expo JavaScript host for a Live Activity intent.'
  s.homepage       = 'https://github.com/lightwork-studio/leve'
  s.license        = { :type => 'AGPL-3.0-only' }
  s.author         = 'Lightwork Studio'
  s.source         = { :git => 'https://github.com/lightwork-studio/leve.git' }
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.static_framework = true
  s.source_files   = '*.swift'
  s.dependency 'Expo'
  s.dependency 'ExpoModulesCore'
  s.dependency 'React-RCTAppDelegate'
end

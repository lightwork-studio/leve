Pod::Spec.new do |s|
  s.name           = 'LeveRestAlert'
  s.version        = '1.0.0'
  s.summary        = 'Schedules the local notification for the end of a rest.'
  s.description    = 'Local notifications only: no push entitlement or remote registration.'
  s.license        = 'MPL-2.0'
  s.author         = 'Leve'
  s.homepage       = 'https://github.com/lightwork-studio/leve'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/lightwork-studio/leve.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end

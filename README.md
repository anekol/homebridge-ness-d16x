# homebridge-ness-d16x
[![CircleCI](https://circleci.com/gh/anekol/homebridge-ness-d16x/tree/main.svg?style=shield)](https://circleci.com/gh/anekol/homebridge-ness-d16x/tree/main)
[![codecov](https://codecov.io/gh/anekol/homebridge-ness-d16x/branch/main/graph/badge.svg)](https://codecov.io/gh/anekol/homebridge-ness-d16x)

A Homebridge plugin to support the Ness D8x / D16x Security Panel and zone accessories.

Requires an interface that supports [Ness D8x / D16x Serial Interface ASCII protocol](http://www.nesscorporation.com/Software/Ness_D8-D16_ASCII_protocol_rev13.pdf) eg.

* [Usriot USR-TCP232-302](https://shop.usriot.com/RS232-to-Ethernet-converter.html)
* [Ness IP232](http://nesscorporation.com/101-244.html)

Night mode is not supported by the Ness D8x/D16x, but is provided as a no-op for use in Homekit rules.

Home mode (Ness Day Mode) may not be configured on your panel. If Ness Day Mode is not configured on your panel and you don't exclude mode "Home", be aware that selecting Away followed by Home will not disarm the panel (Night or Off will).

## Installation
```sh
# npm
npm install homebridge-ness-d16x --save
```
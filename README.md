# Cyano-tools

## Tools to analyze fluorescence, microscopy and spectroscopy data, as obtained in wet-lab measurements for algae, cyanobacteria and eventually for plants 

### The tools, available online (https://tools-py.e-cyanobacterium.org/), are designed to process data for the following methods:
- Fluorometry
  - OJIP curves
  - Rapid light curves
- Microscopy
  - Cell counting
  - Cell size
  - Pixel profiles
- Spectrofluorometry
  - Ratio of PSII/PSI, antenna attachment to PSII or PSI

### The tools accept data files from the following devices:
- Fluorometers
  - Multi-Color PAM / Dual PAM, Walz (.csv)
  - AquaPen / FluorPen, Photon System Instruments (.txt)
- Confocal and fluorescence microscopes (.png, .jpg, .jpeg, .tif, .tiff, .bmp, .gif)
- Spectrofluorometers
  - FP series, Jasco (.csv)

### The tools are based on python Flask, and are hosted at https://www.pythonanywhere.com/. The files related to individual tools are stored in the folder **Website** within main folder (Flask_server). The folder **Website** contains the following sub-folders and files:
- folder **static**
  - folder **images**
  - folder **files**
  - folder **uploads**
  - files:
    - .css file
    - all .js files
- folder **templates**
- files:
  -   


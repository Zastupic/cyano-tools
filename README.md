# Cyano-tools

## Tools to analyze fluorescence, microscopy and spectroscopy data, as obtained in wet-lab measurements for algae, cyanobacteria and eventually for plants 

### The tools, available online (https://tools-py.e-cyanobacterium.org/), are designed to process data for the following methods:
- ***Fluorometry***
  - ***OJIP curves***
    - Shifting (to F<sub>0</sub>' and F<sub>P</sub>) and normalizing (between F<sub>0</sub>' and F<sub>P</sub>) the measured curves
    - Plotting the measured curves
    - Iidentification of F<sub>J</sub> and F<sub>I</sub> timing based on second derivation of the fluorescence signal
    - Eventual manual correction of F<sub>J</sub> and F<sub>I</sub> timing
    - Calculation of relevant parameters, including those based on F<sub>J</sub> and F<sub>I</sub>,
    - Exporting all results and plots to **.xlsx** file
  - ***Rapid light curves***
    - Plotting the measured curves
    - Fitting the measured curves by the equation of Platt et al., 1980
    - Calculation of relevant parameters
    - Exporting all results and plots to **.xlsx** file
- ***Microscopy***
  - ***Cell counting***
    - ***Round cells***
      - Automated identification of the cells on a fluorescence microscopy image
      - Automated counting of the cells
      - Eventual manual correction
      - Exporting all results and plots to **.xlsx** file
    - ***Filamentous strains***
      - Automated identification of filaments on a fluorescence microscopy image
      - Automated splitting the filaments to individual cells, and counting the individual cells
      - Eventual manual correction
      - Exporting all results and plots to **.xlsx** file
  - ***Cell size estimation***
    - ***Round cells***
      - Manual selection of the cells on a fluorescence microscopy image
      - Automated determination of size of the selected cells, including plotting
      - Exporting all results and plots to **.xlsx** file
    - ***Filamentous strains***
      - Manual selection of the cells on a microscopy image
      - Manual determination of size of the selected cells, including plotting
      - Exporting all results and plots to **.xlsx** file
  - ***Pixel profiles***
    - ***Round cells***
      - Manual selection of the cells on a fluorescence microscopy image
      - Automated determination of pixels intensity across the cell profile  (with fixed angle of 15°), including plotting
      - Exporting all results and plots to **.xlsx** file
    - ***Filamentous strains***
      - Manual selection of the cells and cells cross-section on a microscopy image
      - Automated determination of pixels intensity across the selected cells cross-secions, including plotting
      - Exporting all results and plots to **.xlsx** file
- ***Spectrofluorometry***
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
    - the main **.css** file
    - all **.js** files
- folder **templates**
  - all **.html** files
- files:
  - all **.py** files

